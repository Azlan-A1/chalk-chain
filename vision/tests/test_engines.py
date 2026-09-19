import json
import pathlib
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import synth  # noqa: E402
from chalkvision import app as appmod  # noqa: E402
from chalkvision.reading import BoardReading  # noqa: E402

KEY_VARS = (
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "CHALK_OLLAMA_MODEL",
    "CHALK_VISION_MODE", "CHALK_VISION_PROVIDER", "CHALK_VISION_FALLBACK",
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    for var in KEY_VARS:
        monkeypatch.delenv(var, raising=False)
    from chalkvision.reuse import ReuseIndex

    monkeypatch.setattr(appmod, "reuse_index", ReuseIndex(tmp_path / "reuse.json"))


@pytest.mark.parametrize(
    "env, expected",
    [
        ({}, []),
        ({"ANTHROPIC_API_KEY": "a"}, ["claude"]),
        ({"OPENAI_API_KEY": "o"}, ["openai"]),
        ({"ANTHROPIC_API_KEY": "a", "OPENAI_API_KEY": "o"}, ["claude", "openai"]),
        ({"ANTHROPIC_API_KEY": "a", "OPENAI_API_KEY": "o", "CHALK_VISION_PROVIDER": "openai"}, ["openai", "claude"]),
        ({"ANTHROPIC_API_KEY": "a", "OPENAI_API_KEY": "o", "CHALK_VISION_MODE": "openai"}, ["openai", "claude"]),
        ({"ANTHROPIC_API_KEY": "a", "OPENAI_API_KEY": "o", "CHALK_VISION_MODE": "mock"}, []),
        ({"GEMINI_API_KEY": "g"}, ["gemini"]),
        ({"GOOGLE_API_KEY": "g"}, ["gemini"]),
        ({"CHALK_OLLAMA_MODEL": "qwen2.5vl:7b"}, ["ollama"]),
        ({"GEMINI_API_KEY": "g", "CHALK_OLLAMA_MODEL": "m", "ANTHROPIC_API_KEY": "a"}, ["claude", "gemini", "ollama"]),
        ({"GEMINI_API_KEY": "g", "CHALK_OLLAMA_MODEL": "m", "CHALK_VISION_PROVIDER": "ollama"}, ["ollama", "gemini"]),
    ],
)
def test_engine_order(monkeypatch, env, expected):
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    assert appmod.engines() == expected
    assert appmod.engine_name() == (expected[0] if expected else "mock")


def verify(client, expected=("lion", "cup", "rain")):
    return client.post(
        "/verify",
        files={"image": ("photo.jpg", synth.jpeg(synth.classroom(list(expected))), "image/jpeg")},
        data={"expected": json.dumps(list(expected)), "prior": "[]", "photo_id": "t:1:0", "group_id": "t:1"},
    )


def fake_readers(monkeypatch, results):
    """results: engine -> BoardReading or Exception."""
    def reader(name):
        def read(img):
            r = results[name]
            if isinstance(r, Exception):
                raise r
            return r
        return read

    monkeypatch.setattr(appmod, "_reader", reader)


def test_falls_back_to_second_provider(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    monkeypatch.setenv("OPENAI_API_KEY", "o")
    fake_readers(monkeypatch, {
        "claude": RuntimeError("overloaded"),
        "openai": BoardReading(board_text=["lion", "cup", "rain"], people=6, looks_like_screen=False),
    })
    v = verify(TestClient(appmod.app)).json()
    assert v["engine"] == "openai" and v["words_ok"] and v["headcount"] == 6


def test_all_providers_fail_is_502_unless_mock_fallback(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "o")
    fake_readers(monkeypatch, {"openai": RuntimeError("bad key")})
    client = TestClient(appmod.app)
    r = verify(client)
    assert r.status_code == 502 and "openai: bad key" in r.json()["detail"]

    monkeypatch.setenv("CHALK_VISION_FALLBACK", "mock")
    assert verify(client).json()["engine"] == "mock-fallback"


def test_transcript_drives_the_word_check(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "o")
    captured = {}

    def read(img):
        captured["called"] = True
        # The model transcribes a board that also carries a word nobody asked for.
        return BoardReading(board_text=["lion", "cup", "rain", "zebra"], people=5, looks_like_screen=False)

    monkeypatch.setattr(appmod, "_reader", lambda name: read)
    v = verify(TestClient(appmod.app)).json()
    assert captured["called"] and v["engine"] == "openai"
    assert v["words_found"] == [True, True, True] and v["board_text"] == ["lion", "cup", "rain", "zebra"]


def test_ollama_request_shape(monkeypatch):
    from chalkvision import ollama_engine

    monkeypatch.setenv("CHALK_OLLAMA_MODEL", "qwen2.5vl:7b")
    sent = {}

    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"message": {"content": json.dumps(
                {"board_text": ["lion"], "people": 4, "looks_like_screen": False})}}

    def fake_post(url, json, timeout):
        sent.update(url=url, body=json)
        return Resp()

    monkeypatch.setattr(ollama_engine.httpx, "post", fake_post)
    reading = ollama_engine.read_board(synth.classroom(["lion"]))
    assert reading.board_text == ["lion"] and reading.people == 4
    body = sent["body"]
    assert sent["url"].endswith("/api/chat") and body["model"] == "qwen2.5vl:7b" and body["stream"] is False
    assert body["format"]["required"] == ["board_text", "people", "looks_like_screen"]
    assert body["options"]["num_predict"] == ollama_engine.NUM_PREDICT
    assert len(body["messages"][0]["images"]) == 1


def test_ollama_retries_once_then_succeeds(monkeypatch):
    from chalkvision import ollama_engine

    monkeypatch.setenv("CHALK_OLLAMA_MODEL", "qwen2.5vl:7b")
    calls = {"n": 0}

    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"message": {"content": json.dumps(
                {"board_text": ["lion"], "people": 2, "looks_like_screen": False})}}

    def flaky(url, json, timeout):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("500 Internal Server Error")
        return Resp()

    monkeypatch.setattr(ollama_engine.httpx, "post", flaky)
    assert ollama_engine.read_board(synth.classroom(["lion"])).board_text == ["lion"]
    assert calls["n"] == 2
