import json
import sys
import pathlib

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import synth  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CHALK_VISION_MODE", "mock")
    monkeypatch.setenv("CHALK_REUSE_DB", str(tmp_path / "reuse.json"))
    from chalkvision import app as appmod
    from chalkvision.reuse import ReuseIndex

    monkeypatch.setattr(appmod, "reuse_index", ReuseIndex(tmp_path / "reuse.json"))
    return TestClient(appmod.app)


def post(client, img_bytes, photo_id, group_id, expected=("lion", "cup", "rain"), prior=()):
    return client.post(
        "/verify",
        files={"image": ("photo.jpg", img_bytes, "image/jpeg")},
        data={
            "expected": json.dumps(list(expected)),
            "prior": json.dumps([list(p) for p in prior]),
            "photo_id": photo_id,
            "group_id": group_id,
            "lang": "en",
        },
    )


def test_health(client):
    assert client.get("/health").json() == {"ok": True, "engine": "mock"}


def test_mock_verify_shape(client):
    r = post(client, synth.jpeg(synth.classroom(["lion", "cup", "rain"])), "t:1:0", "t:1")
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["words_ok"] and v["chain_ok"] and v["words_found"] == [True, True, True]
    assert v["headcount"] == 7 and v["is_recapture"] is False
    assert v["reuse"]["is_reuse"] is False and v["engine"] == "mock"


def test_reuse_across_groups_but_not_within(client):
    b = synth.jpeg(synth.classroom(["lion"], seed=1))
    assert not post(client, b, "a:1:0", "a:1").json()["reuse"]["is_reuse"]
    assert not post(client, b, "a:1:1", "a:1").json()["reuse"]["is_reuse"]  # same day: allowed
    other = post(client, b, "b:1:0", "b:1").json()["reuse"]
    assert other["is_reuse"] and other["exact_duplicate"] and other["match_id"].startswith("a:1:")
    # Re-encoded copy is a near duplicate, not an exact one.
    near = post(client, synth.jpeg(synth.classroom(["lion"], seed=1), quality=70), "c:1:0", "c:1").json()["reuse"]
    assert near["is_reuse"] and not near["exact_duplicate"]
    fresh = post(client, synth.jpeg(synth.classroom(["cup"], seed=9)), "d:1:0", "d:1").json()["reuse"]
    assert not fresh["is_reuse"]


def test_moire_flags_recapture(client):
    img = synth.add_moire(synth.classroom(["lion"], seed=3), period=4, amp=30)
    v = post(client, synth.png(img), "e:1:0", "e:1").json()
    assert v["is_recapture"] is True


def test_bad_inputs(client):
    assert post(client, b"not an image", "x:1:0", "x:1").status_code == 400
    r = client.post("/verify", files={"image": ("p.jpg", b"x", "image/jpeg")}, data={"expected": "nope", "photo_id": "a", "group_id": "b"})
    assert r.status_code == 400
