#!/usr/bin/env python3
"""
Verify group chat history truncation/compression.

Compares:
1. collab.db room_messages (source of truth)
2. Workspace delta fed to each bot (watermark + GROUP_CHAT_HISTORY_LIMIT)
3. Gateway state.db messages for each bot session

Usage: python3 scripts/verify-group-chat-history.py [room_id]
Default room: test group room with messages.
"""
import sqlite3
import json
import sys
from pathlib import Path

GROUP_CHAT_HISTORY_LIMIT = 24

COLLAB_DB = Path.home() / '.hermes' / 'collab.db'
PROFILES_ROOT = Path.home() / '.hermes' / 'profiles'


def rowdicts(cur):
    rows = cur.fetchall()
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in rows]


def get_room(collab, room_id):
    cur = collab.execute(
        'SELECT id, title FROM rooms WHERE id = ?', (room_id,)
    )
    rows = rowdicts(cur)
    return rows[0] if rows else None


def get_members(collab, room_id):
    cur = collab.execute(
        "SELECT participant_id, display_name, profile, runtime FROM room_participants "
        "WHERE room_id = ? AND removed_at = 0", (room_id,)
    )
    return rowdicts(cur)


def get_room_messages(collab, room_id):
    cur = collab.execute(
        'SELECT id, sender_kind, sender_participant_id, sender_name, content, created_at '
        'FROM room_messages WHERE room_id = ? ORDER BY created_at ASC', (room_id,)
    )
    return rowdicts(cur)


def get_watermarks(collab, room_id):
    cur = collab.execute(
        'SELECT participant_id, message_count FROM room_watermarks WHERE room_id = ?',
        (room_id,),
    )
    return {r['participant_id']: r['message_count'] for r in rowdicts(cur)}


def get_group_sessions(collab, room_id):
    cur = collab.execute(
        'SELECT room_id, participant_id, session_id, profile FROM group_chat_sessions '
        'WHERE room_id = ?', (room_id,)
    )
    return {r['participant_id']: r for r in rowdicts(cur)}


def get_state_db_messages(state_db, session_id):
    conn = sqlite3.connect(state_db)
    conn.row_factory = sqlite3.Row
    cur = conn.execute(
        'SELECT id, role, content, timestamp, token_count, active, compacted, _compressed_summary '
        'FROM messages WHERE session_id = ? ORDER BY timestamp ASC', (session_id,)
    )
    rows = rowdicts(cur)
    # Identify compressed/summary messages by heuristics
    for r in rows:
        text = r['content'] or ''
        r['looks_summary'] = '[SUMMARY' in text or '(summary' in text.lower() or 'summary of' in text.lower()
    conn.close()
    return rows


def format_msg(m, max_len=60):
    content = (m.get('content') or '')[:max_len]
    return f"{m.get('sender_participant_id') or m.get('role')}: {content}"


def main():
    room_id = sys.argv[1] if len(sys.argv) > 1 else None
    if not COLLAB_DB.exists():
        print(f'collab.db not found: {COLLAB_DB}')
        return 1

    collab = sqlite3.connect(COLLAB_DB)
    collab.row_factory = sqlite3.Row

    if not room_id:
        cur = collab.execute(
            'SELECT id, title FROM rooms ORDER BY updated_at DESC LIMIT 1'
        )
        row = cur.fetchone()
        if not row:
            print('No rooms in collab.db')
            return 1
        room_id = row['id']

    room = get_room(collab, room_id)
    if not room:
        print(f'Room not found: {room_id}')
        return 1

    all_messages = get_room_messages(collab, room_id)
    members = get_members(collab, room_id)
    watermarks = get_watermarks(collab, room_id)
    sessions = get_group_sessions(collab, room_id)

    print(f"Room: {room['id']}  title={room['title']!r}")
    print(f"Total room_messages in collab.db: {len(all_messages)}")
    print(f"Members: {', '.join(m['participant_id'] for m in members)}")
    print()

    for m in members:
        pid = m['participant_id']
        wm = watermarks.get(pid, 0)
        delta = all_messages[wm:][:GROUP_CHAT_HISTORY_LIMIT]
        if len(all_messages) > wm:
            delta = all_messages[wm:][-GROUP_CHAT_HISTORY_LIMIT:]
        else:
            delta = []

        print(f'--- {pid} ---')
        print(f'  watermark: {wm}')
        print(f'  unread count: {max(0, len(all_messages) - wm)}')
        print(f'  delta fed (max 24): {len(delta)}')
        for mm in delta[:3]:
            print(f'    - {format_msg(mm)}')
        if len(delta) > 3:
            print(f'    ... and {len(delta) - 3} more')

        s = sessions.get(pid)
        if not s:
            print('  gateway session: not found in group_chat_sessions')
            continue
        profile = s.get('profile') or pid
        state_db = PROFILES_ROOT / profile / 'state.db'
        if not state_db.exists():
            print(f'  gateway state.db: not found: {state_db}')
            continue
        gw_rows = get_state_db_messages(state_db, s['session_id'])
        summary_rows = [r for r in gw_rows if r.get('looks_summary') or r.get('_compressed_summary') or r.get('compacted')]
        print(f'  gateway session_id: {s["session_id"]}')
        print(f'  gateway messages in state.db: {len(gw_rows)}')
        print(f'  gateway compressed/summary rows: {len(summary_rows)}')
        if summary_rows:
            print('  gateway first summary row:')
            print(f'    role={summary_rows[0]["role"]} ts={summary_rows[0]["timestamp"]}')
            print(f'    content={summary_rows[0]["content"][:200]}')
        print()

    collab.close()


if __name__ == '__main__':
    main()
