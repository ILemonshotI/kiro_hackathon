"""LangGraph agent: Nova Lite answers in character with text + emotion + move.

Graph: tools (one bind_tools call, no loop) -> answer (structured output). Memory per thread_id.
"""

import json
import logging
import random
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from langchain_aws import ChatBedrockConverse
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import START, MessagesState, StateGraph
from pydantic import BaseModel, Field

load_dotenv()  # optional: on the server the AWS role is used instead

log = logging.getLogger(__name__)

MODEL_ID = "us.amazon.nova-lite-v1:0"
REGION = "us-east-1"
MAX_MESSAGES = 20
SAFE_LINE = "Sorry friend, I lost my train of thought. Could you say that again?"

CHARACTER = json.loads((Path(__file__).parent / "character.json").read_text(encoding="utf-8"))
MOVES = [m for m in CHARACTER.get("moves", []) if m.get("name")]
MOVE_NAMES = tuple(m["name"] for m in MOVES) + ("none",)

SYSTEM_PROMPT = (
    CHARACTER["personality"]
    + "\n\nRules:\n"
    "- Reply in 1 to 3 short sentences.\n"
    "- No lists, no emojis, no markdown.\n"
    "- Be friendly and family-safe: you are shown on a big screen.\n"
    "- Always stay in character.\n"
    "- Pick the emotion that best fits your reply.\n"
    "- Quiz: ask one short question, then stop and wait for the user's answer. Never answer your own question.\n"
    "- When the moment matches one of these moves, pick it; otherwise move is none. Moves:\n"
    + "".join(f"  - {m['name']}: {m['when']}\n" for m in MOVES)
)

TOOLS_PROMPT = (
    "You are the tool router for a chat character. Call a tool only if the user's latest message needs it:\n"
    "- roll_dice when the user asks to roll dice or wants a random lucky number.\n"
    "- quiz_score only when the user's latest message correctly answers the quiz question the assistant just asked (points=1), "
    "or asks for their score (points=0), or wants to reset it (reset=true).\n"
    "If no tool is needed, reply with just: none"
)


# ---------- Tools ----------
@tool
def roll_dice(count: int = 1, sides: int = 6) -> str:
    """Roll `count` dice with `sides` sides each and return the results."""
    count = max(1, min(int(count), 10))
    sides = max(2, min(int(sides), 100))
    rolls = [random.randint(1, sides) for _ in range(count)]
    return f"Rolled {count}d{sides}: {rolls}, total {sum(rolls)}"


@tool
def quiz_score(points: int = 0, reset: bool = False) -> str:
    """Add points to the user's quiz score (0 to just read it), or reset it to 0."""
    return ""  # executed in run_tools, which owns the per-thread score


TOOLS = {"roll_dice": roll_dice, "quiz_score": quiz_score}


class Reply(BaseModel):
    """The character's answer."""

    text: str = Field(description="What the character says out loud, 1-3 short sentences.")
    emotion: Literal["neutral", "happy", "angry", "sad", "relaxed"] = Field(
        description="Facial emotion shown while speaking."
    )
    move: Literal[MOVE_NAMES] = Field(  # type: ignore[valid-type]
        default="none",
        description="Body move to play after speaking. "
        + " ".join(f"Use '{m['name']}' when {m['when']}." for m in MOVES)
        + " Otherwise 'none'.",
    )


class State(MessagesState):
    emotion: str
    move: str
    score: int
    tool_notes: str


_base = ChatBedrockConverse(model=MODEL_ID, region_name=REGION)
llm = _base.with_structured_output(Reply, include_raw=True)
tool_llm = _base.bind_tools(list(TOOLS.values()))


def _raw_text(raw) -> str:
    """Plain text from a raw AIMessage (content may be a string or a list of blocks)."""
    content = getattr(raw, "content", "")
    if isinstance(content, list):
        content = " ".join(b.get("text", "") for b in content if isinstance(b, dict))
    return (content or "").strip()


def _trim(messages, limit: int = MAX_MESSAGES):
    """Keep the last `limit`; Bedrock needs the conversation to start with a user turn."""
    recent = messages[-limit:]
    while recent and not isinstance(recent[0], HumanMessage):
        recent = recent[1:]
    return recent


def run_tools(state: State):
    """One tool-calling pass (never loops). Results go to the answer step as notes."""
    score = state.get("score", 0) or 0
    notes = []
    try:
        out = tool_llm.invoke([SystemMessage(TOOLS_PROMPT), *_trim(state["messages"], 6)])
        for call in getattr(out, "tool_calls", []) or []:
            name, args = call.get("name"), call.get("args") or {}
            if name == "roll_dice":
                notes.append(roll_dice.invoke(args))
            elif name == "quiz_score":
                score = 0 if args.get("reset") else score + int(args.get("points", 0) or 0)
                notes.append(f"Quiz score is now {score}")
    except Exception as exc:  # noqa: BLE001  tools are optional: answer without them
        log.warning("Tool step failed: %s", type(exc).__name__)
    if notes:
        log.info("Tool results: %s", notes)
    return {"score": score, "tool_notes": "; ".join(notes)}


def answer(state: State):
    messages = _trim(state["messages"])
    if state.get("tool_notes") and messages and isinstance(messages[-1], HumanMessage):
        # Transient note on the latest user turn only (not stored in memory).
        note = f"\n\n[Tool results: {state['tool_notes']}. Say these exact results in your reply.]"
        messages = [*messages[:-1], HumanMessage(messages[-1].content + note)]
    out = llm.invoke([SystemMessage(SYSTEM_PROMPT), *messages])
    reply = out.get("parsed")
    if not isinstance(reply, Reply) or not reply.text.strip():
        log.warning("Invalid structured output, using fallback: %s", out.get("parsing_error"))
        reply = Reply(text=_raw_text(out.get("raw")) or SAFE_LINE, emotion="neutral", move="none")
    return {"messages": [AIMessage(reply.text)], "emotion": reply.emotion, "move": reply.move, "tool_notes": ""}


builder = StateGraph(State)
builder.add_node("tools", run_tools)
builder.add_node("answer", answer)
builder.add_edge(START, "tools")
builder.add_edge("tools", "answer")
graph = builder.compile(checkpointer=InMemorySaver())


def _config(thread_id: str):
    return {"configurable": {"thread_id": thread_id}}


def _to_reply(result) -> Reply:
    move = result.get("move", "none")
    return Reply(
        text=result["messages"][-1].content,
        emotion=result.get("emotion", "neutral"),
        move=move if move in MOVE_NAMES else "none",
    )


async def ask(text: str, thread_id: str) -> Reply:
    """Send the user's text on this conversation thread; returns the character's Reply."""
    result = await graph.ainvoke({"messages": [HumanMessage(text)]}, _config(thread_id))
    return _to_reply(result)


def ask_sync(text: str, thread_id: str) -> Reply:
    """Sync version (e.g. for asyncio.to_thread or scripts)."""
    result = graph.invoke({"messages": [HumanMessage(text)]}, _config(thread_id))
    return _to_reply(result)
