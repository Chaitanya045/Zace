from __future__ import annotations

from typing import Optional, TypedDict

from rich.align import Align
from rich.padding import Padding
from rich.text import Text


class ChatItem(TypedDict):
    final_state: str | None
    role: str
    text: str


def build_chat_line(role: str, text: str, final_state: str | None, edge_padding: int) -> Align:
    line = Text()
    alignment = "left"
    label_style = "#6A737D"
    label = "system"
    content: Text | Padding = line

    if role == "user":
        alignment = "right"
        label_style = "#4EA5FF"
        label = "you"
    elif role == "assistant":
        label_style = "#2BEE8C"
        label = "agent"

    line.append(label, style=label_style)
    line.append(": ")
    line.append(text)
    if final_state:
        line.append(f" ({final_state})", style="#88D498")

    if role == "user":
        content = Padding(line, (0, edge_padding, 0, 0))
    else:
        content = Padding(line, (0, 0, 0, edge_padding))

    return Align(content, align=alignment)


def apply_stream_chat_chunk(
    chat_items: list[ChatItem],
    stream_index_by_id: dict[str, int],
    role: str,
    text: str,
    final_state: Optional[str],
    stream_id: str,
    chunk: str,
) -> bool:
    if chunk == "start":
        chat_items.append(
            {
                "final_state": None,
                "role": role,
                "text": text,
            }
        )
        stream_index_by_id[stream_id] = len(chat_items) - 1
        return True

    index = stream_index_by_id.get(stream_id)
    if index is None or index >= len(chat_items):
        chat_items.append(
            {
                "final_state": final_state,
                "role": role,
                "text": text,
            }
        )
        stream_index_by_id[stream_id] = len(chat_items) - 1
        return True

    if chunk == "delta":
        current_text = chat_items[index].get("text", "") or ""
        chat_items[index]["text"] = f"{current_text}{text}"
        return True

    if chunk == "end":
        if final_state:
            chat_items[index]["final_state"] = final_state
        stream_index_by_id.pop(stream_id, None)
        return True

    return False
