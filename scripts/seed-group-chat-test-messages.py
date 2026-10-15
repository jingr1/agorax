#!/usr/bin/env python3
"""Seed a group chat room with synthetic human messages to trigger truncation.

Usage:
  python3 scripts/seed-group-chat-test-messages.py <room_id> <count>

Inserts messages as sender_kind='human', sender_name='User' with monotonic
content. Existing participant watermarks are NOT updated, so every member's
unread delta grows by <count>.
"""
import sqlite3
import sys
from pathlib import Path

COLLAB = Path.home() / '.hermes' / 'collab.db'


def create_collab_id(prefix: str, ts: int) -> str:
    # matches createCollabId in src/server/collab-db.ts
    return f"{prefix}_{ts:x}_{abs(hash((prefix, ts))) % 0xffff_ffff_ffff:x}"


def main() -> int:
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <room_id> <count>")
        return 1
    room_id = sys.argv[1]
    count = int(sys.argv[2])
    conn = sqlite3.connect(COLLAB)
    conn.row_factory = sqlite3.Row
    cur = conn.execute('SELECT id FROM rooms WHERE id = ?', (room_id,))
    if not cur.fetchone():
        print(f'Room not found: {room_id}')
        return 1
    cur = conn.execute(
        'SELECT MAX(created_at) as max_ts FROM room_messages WHERE room_id = ?',
        (room_id,),
    )
    base_ts = cur.fetchone()['max_ts'] or 0
    rows = []
    now_ts = max(base_ts + 1, int(__import__('time').time() * 1000))
    for i in range(count):
        ts = now_ts + i
        msg_id = create_collab_id('msg', ts)
        rows.append((msg_id, room_id, 'human', None, 'User',
                     f'Test message {i + 1}/{count} to verify GROUP_CHAT_HISTORY_LIMIT truncation.',
                     '[]', 0, 0, '[]', None, None, None, ts))
    conn.executemany(
        'INSERT INTO room_messages '
        '(id, room_id, sender_kind, sender_participant_id, sender_name, content, '
        'mentions, mention_depth, auto_handoff, task_refs, answers_pending_turn_id, '
        'run_id, task_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        rows,
    )
    conn.commit()
    conn.close()
    print(f'Inserted {count} test messages into {room_id}; timestamps start at {now_ts}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
