from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import (
    accounts,
    auth_session,
    balance_entries,
    budget,
    categories,
    networth,
    put_aside,
)
from app.db import close_pool, init_pool


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await init_pool()
    yield
    await close_pool()


app = FastAPI(title="net-tracker", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_session.router)
app.include_router(categories.router)
app.include_router(accounts.router)
app.include_router(balance_entries.router)
app.include_router(networth.router)
app.include_router(budget.router)
app.include_router(put_aside.router)


@app.get("/")
def health() -> dict[str, str]:
    return {"status": "ok"}
