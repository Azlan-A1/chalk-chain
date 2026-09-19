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

KEY_VARS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CHALK_VISION_MODE", "CHALK_VISION_PROVIDER", "CHALK_VISION_FALLBACK")


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
        def read(img, candidates):
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
        "openai": BoardReading(words_on_board=["lion", "cup", "rain"], people=6, looks_like_screen=False, notes=""),
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


def test_decoy_seen_by_openai_fails_words(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "o")
    captured = {}

    def read(img, candidates):
        captured["candidates"] = candidates
        decoy = next(c for c in candidates if c not in ("lion", "cup", "rain"))
        return BoardReading(words_on_board=["lion", "cup", "rain", decoy], people=5, looks_like_screen=False, notes="")

    monkeypatch.setattr(appmod, "_reader", lambda name: read)
    v = verify(TestClient(appmod.app)).json()
    assert len(captured["candidates"]) == 9  # 3 expected + 6 decoys
    assert v["engine"] == "openai" and not v["words_ok"] and len(v["decoys_flagged"]) == 1
