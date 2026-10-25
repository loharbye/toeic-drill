#!/usr/bin/env python3
"""問題データの形式チェック。

使い方:
  python3 tools/check_data.py            # チェックのみ
  python3 tools/check_data.py --balance  # Part 5 の正解位置を A〜D に均等に並べ替えて保存

正解が1つに決まるか（内容の妥当性）はこのスクリプトでは判定できないので、
生成後に Claude Code に「別途レビュー」を依頼すること。
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
errors = []


def err(msg):
    errors.append(msg)


def check_part5(items):
    ids = set()
    for q in items:
        qid = q.get("id", "?")
        if qid in ids:
            err(f"{qid}: id が重複")
        ids.add(qid)
        for key in ("part", "category", "question", "choices", "answer", "explanation", "trap"):
            if key not in q or q[key] in ("", None):
                err(f"{qid}: {key} がない")
        choices = q.get("choices", [])
        if len(choices) != 4:
            err(f"{qid}: 選択肢が4つではない")
        if len(set(c.lower() for c in choices)) != len(choices):
            err(f"{qid}: 選択肢が重複")
        if not (0 <= q.get("answer", -1) < len(choices)):
            err(f"{qid}: answer の範囲外")
        if not re.search(r"-{3,}", q.get("question", "")):
            err(f"{qid}: 空欄（-------）がない")
        if q.get("category") not in ("grammar", "vocabulary"):
            err(f"{qid}: category は grammar / vocabulary")


def balance_part5(items):
    """i 番目の問題の正解を i % 4 の位置へ移動（選択肢を入れ替えるだけなので正誤は変わらない）。"""
    for i, q in enumerate(items):
        target = i % 4
        a = q["answer"]
        if a != target:
            q["choices"][a], q["choices"][target] = q["choices"][target], q["choices"][a]
            q["answer"] = target


def check_vocab(items):
    ids, words = set(), set()
    for v in items:
        vid = v.get("id", "?")
        if vid in ids:
            err(f"{vid}: id が重複")
        ids.add(vid)
        w = v.get("word", "")
        if w.lower() in words:
            err(f"{vid}: 単語 {w} が重複")
        words.add(w.lower())
        for key in ("word", "pos", "meaning", "synonyms", "example"):
            if not v.get(key):
                err(f"{vid}: {key} がない")
        if not re.search(rf"\b{re.escape(w)}\b", v.get("example", ""), re.I):
            err(f"{vid}: 例文に {w} がそのままの形で含まれていない（空欄・言い換え問題が作れない）")
        d = v.get("distractors", [])
        if d and len(d) < 3:
            err(f"{vid}: distractors は3つ以上")
        if w.lower() in (x.lower() for x in d):
            err(f"{vid}: distractors に正解が含まれている")
    for v in items:
        for r in v.get("related", []):
            if r.lower() not in words:
                err(f"{v['id']}: related の {r} が語彙データにない")


def main():
    p5_path = ROOT / "data" / "part5.json"
    vocab_path = ROOT / "data" / "vocab.json"
    part5 = json.loads(p5_path.read_text(encoding="utf-8"))
    vocab = json.loads(vocab_path.read_text(encoding="utf-8"))

    if "--balance" in sys.argv:
        balance_part5(part5)
        p5_path.write_text(
            "[\n" + ",\n".join("  " + json.dumps(q, ensure_ascii=False) for q in part5) + "\n]\n",
            encoding="utf-8",
        )
        print("Part 5 の正解位置を均等化して保存しました")

    check_part5(part5)
    check_vocab(vocab)

    pos = Counter("ABCD"[q["answer"]] for q in part5 if 0 <= q.get("answer", -1) < 4)
    cat = Counter(q.get("category") for q in part5)
    print(f"Part 5: {len(part5)} 問  {dict(cat)}  正解位置 {dict(sorted(pos.items()))}")
    print(f"語彙: {len(vocab)} 語  {dict(Counter(v.get('pos') for v in vocab))}")

    if errors:
        print(f"\n問題が {len(errors)} 件あります:")
        for e in errors:
            print("  - " + e)
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    main()
