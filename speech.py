"""Amazon Polly: mp3 audio + viseme/word speech marks, fetched in parallel."""

import json
from concurrent.futures import ThreadPoolExecutor

import boto3
from dotenv import load_dotenv

load_dotenv()  # optional: on the server the AWS role is used instead

polly = boto3.client("polly", region_name="us-east-1")
_pool = ThreadPoolExecutor(max_workers=4)


def _mp3(text: str, voice: str) -> bytes:
    res = polly.synthesize_speech(Text=text, VoiceId=voice, Engine="neural", OutputFormat="mp3")
    return res["AudioStream"].read()


def _marks(text: str, voice: str) -> list[dict]:
    res = polly.synthesize_speech(
        Text=text,
        VoiceId=voice,
        Engine="neural",
        OutputFormat="json",
        SpeechMarkTypes=["viseme", "word"],
    )
    lines = res["AudioStream"].read().decode("utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


def synthesize(text: str, voice: str) -> tuple[bytes, list[dict]]:
    """Returns (mp3_bytes, marks). Each mark: {"time": ms, "type": "viseme"|"word", "value": ...}."""
    audio = _pool.submit(_mp3, text, voice)
    marks = _pool.submit(_marks, text, voice)
    return audio.result(), marks.result()
