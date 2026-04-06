#!/usr/bin/env python3
"""
compress.py — Compress conversation history to reduce token usage.
Reads JSON from stdin, writes compressed summary to stdout.

Input (stdin):
  {
    "history": [{"role":"user","content":"...","ts":"..."}, ...],
    "currentMessage": "...",
    "phoneNumber": "+254..."
  }

Output (stdout):
  {
    "compressed": "...",
    "originalTokens": 3000,
    "compressedTokens": 400
  }
"""
import sys
import json
import re

def rough_token_count(text):
    """~4 chars per token heuristic."""
    return max(1, len(text) // 4)

def compress_history(history, current_message, phone_number):
    if not history:
        return {
            "compressed": "",
            "originalTokens": 0,
            "compressedTokens": 0
        }

    original_text = json.dumps(history)
    original_tokens = rough_token_count(original_text)

    lines = []
    for msg in history:
        role = msg.get("role", "unknown")
        content = msg.get("content", "").strip()
        ts = msg.get("ts", "")
        time_label = ""
        if ts:
            try:
                from datetime import datetime, timezone
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                time_label = dt.strftime("%H:%M")
            except Exception:
                pass

        # Strip filler phrases to compress
        content = re.sub(
            r'\b(I think|I believe|I mean|you know|sort of|kind of|basically|'
            r'actually|literally|honestly|just|really|very|quite|perhaps|maybe|'
            r'I was wondering if|could you please|would you mind|'
            r'I hope you|thank you for|thanks for)\b',
            '', content, flags=re.IGNORECASE
        )
        content = re.sub(r'\s{2,}', ' ', content).strip()
        content = content[:200] + '…' if len(content) > 200 else content

        if role == "user":
            label = "Them"
        elif role == "assistant":
            label = "Us"
        else:
            label = role.capitalize()

        if time_label:
            lines.append(f"[{time_label}] {label}: {content}")
        else:
            lines.append(f"{label}: {content}")

    # Group consecutive same-role messages
    compressed_lines = []
    i = 0
    while i < len(lines):
        compressed_lines.append(lines[i])
        i += 1

    compressed = "\n".join(compressed_lines)

    # If still too long, keep only last 4 exchanges with a preamble
    compressed_tokens = rough_token_count(compressed)
    if compressed_tokens > 600 and len(history) > 4:
        recent = history[-4:]
        recent_lines = []
        for msg in recent:
            role = msg.get("role", "unknown")
            content = msg.get("content", "").strip()[:150]
            label = "Them" if role == "user" else "Us"
            recent_lines.append(f"{label}: {content}")
        compressed = f"[Earlier context omitted. Recent {len(recent)} msgs:]\n" + "\n".join(recent_lines)
        compressed_tokens = rough_token_count(compressed)

    return {
        "compressed": compressed,
        "originalTokens": original_tokens,
        "compressedTokens": compressed_tokens
    }

def main():
    try:
        data = json.loads(sys.stdin.read())
        history = data.get("history", [])
        current_message = data.get("currentMessage", "")
        phone_number = data.get("phoneNumber", "")
        result = compress_history(history, current_message, phone_number)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({
            "compressed": "",
            "originalTokens": 0,
            "compressedTokens": 0,
            "error": str(e)
        }))
        sys.exit(0)  # non-fatal, server continues without compression

if __name__ == "__main__":
    main()
