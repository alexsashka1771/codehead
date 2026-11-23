"""Deliver committed events from PostgreSQL, including reconnect backfill."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.exc import OperationalError
from starlette.concurrency import run_in_threadpool

from codehead.api.parameters import ResourceId
from codehead.errors import DomainError

router = APIRouter()


@router.websocket("/api/runs/{run_id}/stream")
async def stream(
    websocket: WebSocket, run_id: ResourceId, after_seq: Annotated[int, Query(ge=0)] = 0
):
    settings = websocket.app.state.settings
    origin = websocket.headers.get("origin")
    host = websocket.headers.get("host", "").split(":")[0].lower()
    if host not in settings.allowed_hosts or (origin and origin not in settings.allowed_origins):
        await websocket.close(code=1008, reason="origin_forbidden")
        return
    service = websocket.app.state.service
    if service is None:
        await websocket.close(code=1013, reason="dependency_unavailable")
        return
    await websocket.accept()
    cursor = after_seq
    try:
        while True:
            page = await run_in_threadpool(service.events, run_id, cursor, 100)
            for event in page.events:
                await websocket.send_json(event.model_dump(mode="json"))
                cursor = event.seq
            if page.has_more:
                continue
            try:
                message = await asyncio.wait_for(websocket.receive(), timeout=0.25)
                if message["type"] == "websocket.disconnect":
                    return
            except TimeoutError:
                continue
    except WebSocketDisconnect:
        return
    except DomainError as exc:
        await websocket.close(code=1008, reason=exc.code)
    except OperationalError:
        await websocket.close(code=1013, reason="dependency_unavailable")
