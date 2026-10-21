from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

import auth
import common
from routers import automation, chat, jobs, settings, tasks


@asynccontextmanager
async def lifespan(_app: FastAPI):
    common.init_db()
    yield


app = FastAPI(title="Local Job Tracker", version="1.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5175", "http://127.0.0.1:5175"],
    allow_origin_regex=r"^https?://[^/]+:5175$",
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Total-Count"],
)
app.add_middleware(auth.AuthMiddleware)
app.add_middleware(GZipMiddleware, minimum_size=1024)

for router_module in (settings, automation, tasks, chat, jobs):
    app.include_router(router_module.router)

if common.STATIC_DIR and Path(common.STATIC_DIR).is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=common.STATIC_DIR, html=True), name="frontend")
