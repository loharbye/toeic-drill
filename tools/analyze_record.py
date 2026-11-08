import json, sys, collections as C
st = json.load(open(sys.argv[1]))['state']
p5 = {q['id']: q for q in json.load(open(sys.argv[2]))}
vb = {v['id']: v for v in json.load(open(sys.argv[3]))}
logs = st['logs']
days = sorted({l['date'] for l in logs})
print('日数', len(days), days[0], '→', days[-1], ' 回答', len(logs))
print('日別', dict(C.Counter(l['date'] for l in logs)))
for stage in ['vocab', 'main', 'review']:
    L = [l for l in logs if l['stage'] == stage]
    if L: print(stage, len(L), '正答率 %.0f%%' % (100*sum(l['correct'] for l in L)/len(L)), '平均秒 %.0f' % (sum(l['seconds'] for l in L)/len(L)))
P = [l for l in logs if l['stage'] != 'vocab']
print('\n確信度×正誤'); cc = C.Counter((l['confidence'], l['correct']) for l in P); print(dict(cc))
print('ミス原因', C.Counter(l['mistakeReason'] for l in P if not l['correct']))
cat = C.defaultdict(lambda: [0,0]); tag = C.defaultdict(lambda: [0,0])
for l in P:
    q = p5.get(l['questionId'])
    if not q: continue
    cat[q['category']][0] += l['correct']; cat[q['category']][1] += 1
    for t in q.get('tags', []): tag[t][0] += l['correct']; tag[t][1] += 1
print('カテゴリ', {k: f'{a}/{n}' for k, (a, n) in cat.items()})
print('タグ（正答率低い順）')
for t, (a, n) in sorted(tag.items(), key=lambda x: x[1][0]/x[1][1]):
    if n >= 3: print(f'  {a/n:4.0%} {a}/{n} {t}')
# 初見時の正答
first = {}
for l in logs:
    if l['stage'] == 'main' and l['questionId'] not in first: first[l['questionId']] = l
print('Part5 初見正答率 %.0f%% (%d問)' % (100*sum(l['correct'] for l in first.values())/len(first), len(first)))
seen = st['seen']; print('出題回数分布', C.Counter(seen.values()))
print('復習中 Part5', len(st['reviews']), '語彙学習中', len(st['vocab']), '/', len(vb))
V = [l for l in logs if l['stage'] == 'vocab']
print('語彙 mode別', {m: f"{sum(l['correct'] for l in V if l.get('mode')==m)}/{sum(1 for l in V if l.get('mode')==m)}" for m in ['meaning','blank','paraphrase']})
print('語彙 stage分布', C.Counter(v['stage'] for v in st['vocab'].values()))
print('苦手語', [(vb[k]['word'], v['correct'], v['wrong']) for k, v in sorted(st['vocab'].items(), key=lambda x: -x[1]['wrong'])[:8]])
print('settings', st['settings'])
