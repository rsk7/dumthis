"""Local analysis server for the drum machine.

Run:  server/.venv/bin/python server/app.py
Then pick "Local server" as the analysis engine in the web app.

Only listens on 127.0.0.1. Results are cached in server/.cache/results by file hash.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
import tempfile
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from pipeline import PIPELINE_VERSION, Pipeline

HOST = "127.0.0.1"
PORT = 8765
MAX_UPLOAD_BYTES = 300 * 1024 * 1024
CACHE = Path(__file__).resolve().parent / ".cache" / "results"
# The GitHub Pages demo and local dev servers may call this server.
ALLOWED_ORIGINS = r"https://rsk7\.github\.io|http://(localhost|127\.0\.0\.1)(:\d+)?"
STAGES = ["queued", "decoding", "separating", "beats", "transcribing"]

log = logging.getLogger("dumthis")


@dataclass
class Job:
    id: str
    key: str
    status: str = "running"  # running | done | error
    stage: str = "queued"
    progress: float = 0.0
    error: str | None = None
    result: dict | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def view(self) -> dict:
        with self.lock:
            return {
                "id": self.id,
                "status": self.status,
                "stage": self.stage,
                "progress": round(self.progress, 3),
                "error": self.error,
                "result": self.result,
            }


pipeline = Pipeline()
# One job at a time: the models share one GPU and are not thread-safe.
executor = ThreadPoolExecutor(max_workers=1)
jobs: dict[str, Job] = {}

app = FastAPI(title="dumthis analysis server")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    # Chrome asks before a public site (the GitHub Pages demo) talks to localhost.
    allow_private_network=True,
)


def result_dir(key: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{24}", key):
        raise HTTPException(404, "Unknown result")
    return CACHE / key


def with_urls(key: str, result: dict) -> dict:
    return {**result, "key": key, "drumsUrl": f"/api/results/{key}/drums.flac"}


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "device": pipeline.device, "version": PIPELINE_VERSION}


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...)) -> dict:
    suffix = Path(file.filename or "audio").suffix[:10] or ".bin"
    hasher = hashlib.sha256(f"v{PIPELINE_VERSION}".encode())
    size = 0
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "File too large")
            hasher.update(chunk)
            tmp.write(chunk)
    finally:
        tmp.close()
    upload = Path(tmp.name)
    key = hasher.hexdigest()[:24]

    job = Job(id=uuid.uuid4().hex, key=key)
    jobs[job.id] = job
    cached = CACHE / key / "result.json"
    if cached.exists():
        upload.unlink(missing_ok=True)
        job.status, job.stage, job.progress = "done", "transcribing", 1.0
        job.result = with_urls(key, json.loads(cached.read_text()))
        return job.view()

    executor.submit(run_job, job, upload)
    return job.view()


def run_job(job: Job, upload: Path) -> None:
    def progress(stage: str, fraction: float) -> None:
        with job.lock:
            job.stage = stage
            # Overall progress: each stage is an equal slice (separation dominates in practice).
            index = STAGES.index(stage) if stage in STAGES else 0
            job.progress = (index - 1 + fraction) / (len(STAGES) - 1)

    out_dir = CACHE / job.key
    tmp_dir = out_dir.with_suffix(".partial")
    try:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        tmp_dir.mkdir(parents=True)
        result = pipeline.run(upload, tmp_dir, progress)
        (tmp_dir / "result.json").write_text(json.dumps(result))
        shutil.rmtree(out_dir, ignore_errors=True)
        tmp_dir.rename(out_dir)
        with job.lock:
            job.status, job.progress = "done", 1.0
            job.result = with_urls(job.key, result)
    except Exception as err:  # reported to the client
        log.exception("Analysis failed")
        shutil.rmtree(tmp_dir, ignore_errors=True)
        with job.lock:
            job.status, job.error = "error", str(err) or type(err).__name__
    finally:
        upload.unlink(missing_ok=True)


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    return job.view()


@app.get("/api/results/{key}/drums.flac")
def drums_audio(key: str) -> FileResponse:
    path = result_dir(key) / "drums.flac"
    if not path.exists():
        raise HTTPException(404, "Unknown result")
    return FileResponse(path, media_type="audio/flac")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    log.info("Using device: %s", pipeline.device)
    uvicorn.run(app, host=HOST, port=PORT)
