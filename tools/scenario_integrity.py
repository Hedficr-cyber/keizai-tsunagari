"""シナリオの札を、既知の因果が成立する経路に整える。

入力にない項目・理由・値動きは補わない。旧形式の chain で並列の影響が
一列になっている場合は分岐させ、不明な辺や逆符号の区間を矢印で結ばない。
"""

from copy import deepcopy
import re
import unicodedata


POLICY_NODES = {"boj", "fed"}
_NUM = {"up": 1, "down": -1}
_ACTORS = {
    "boj": re.compile(r"日銀|日本銀行"),
    "fed": re.compile(r"\b(?:FRB|FOMC)\b|連邦準備|連邦公開市場", re.I),
}
_PREFIX = (
    r"(?:(?:予想(?:通り|どおり|以上|以下|より)|追加|大幅|小幅|連続|サプライズ|"
    r"\d+(?:\.\d+)?\s*(?:%|bp|ポイント))\s*(?:の|な)?)\s*"
)
_ACTION = re.compile(
    rf"^(?:{_PREFIX})*(利上げ|利下げ)(?:を?(?:実施|決定|決める|決めた|行う)|する|した|へ)?$"
)
_HOLD = re.compile(
    r"^(?:(?:政策)?金利(?:を|は|の)?\s*)?"
    r"(?:据え置き|据え置く|現状維持|変更なし)(?:を?決定|する|した)?$"
)
_ACTOR_PREFIX = re.compile(
    r"^(?:日銀|日本銀行|FRB|FOMC|米連邦準備制度理事会)(?:が|は|の)?\s*", re.I
)


def _actors(text):
    return {node for node, pattern in _ACTORS.items() if pattern.search(text)}


def _policy_direction(label):
    """実施を表す短い区切りだけを採用し、『利下げに前向き』等は採用しない。"""
    directions = set()
    for part in re.split(r"[・、,／/;；:：()]+", label):
        part = _ACTOR_PREFIX.sub("", part.strip())
        if _HOLD.fullmatch(part):
            directions.add("hold")
        elif match := _ACTION.fullmatch(part):
            directions.add("up" if match[1] == "利上げ" else "down")
    # 例えば『据え置き・利下げに前向き』は hold だけになる。
    # 複数の実施方向が書かれた曖昧な場合は推測しない。
    return next(iter(directions)) if len(directions) == 1 else None


def _tags(raw, node_ids, policy_dir, relevant_policies):
    tags = []
    seen = set()
    for tag in raw:
        if not isinstance(tag, dict) or not isinstance(tag.get("node"), str) or tag["node"] not in node_ids:
            continue
        node = tag["node"]
        direction = tag.get("dir")
        if isinstance(direction, (str, int)) and not isinstance(direction, bool):
            direction = {1: "up", -1: "down", "1": "up", "-1": "down"}.get(direction, direction)
        else:
            direction = None
        if node in POLICY_NODES:
            # この予定の政策主体と決定内容を確かめられるときだけ金利の札を残す。
            if node not in relevant_policies or not policy_dir:
                continue
            direction = policy_dir
        if direction not in {"up", "down", "hold"}:
            continue
        if direction == "hold" and node not in POLICY_NODES:
            continue
        key = (node, direction)
        if key not in seen:
            seen.add(key)
            tags.append({"node": node, "dir": direction})
    return tags


def _split_paths(tags, edges):
    """元の順序を守る有向グラフから、重複する近道を除いた分岐経路を返す。"""
    adjacency = [[] for _ in tags]
    for i, before in enumerate(tags):
        for j in range(i + 1, len(tags)):
            after = tags[j]
            if before["dir"] not in _NUM or after["dir"] not in _NUM:
                continue
            signs = edges.get((before["node"], after["node"]), set())
            if any(_NUM[before["dir"]] * sign == _NUM[after["dir"]] for sign in signs):
                adjacency[i].append(j)

    def reachable(start, goal):
        pending, visited = [start], set()
        while pending:
            at = pending.pop()
            if at == goal:
                return True
            if at not in visited:
                visited.add(at)
                pending.extend(adjacency[at])
        return False

    # A→C と A→B→C が両方あるときは、同じ札を二度並べる近道を省く。
    reduced = [
        [j for j in children if not any(k != j and reachable(k, j) for k in children)]
        for children in adjacency
    ]
    incoming = {j for children in reduced for j in children}
    paths = []

    def visit(at, path):
        path = [*path, tags[at]]
        if not reduced[at]:
            paths.append(path)
        else:
            for following in reduced[at]:
                visit(following, path)

    for i in range(len(tags)):
        if i not in incoming:
            visit(i, [])
    return paths


def _path_key(path):
    return tuple((tag["node"], tag["dir"]) for tag in path)


def _subsequence(shorter, longer):
    positions = iter(longer)
    return all(any(item == target for item in positions) for target in shorter)


def normalize_case(case, graph, event=""):
    """case のコピーを、chain を持たず paths を持つ形式で返す。

    label/text などは保持する。各経路は [{node, dir}, ...] で、dir は
    up/down、明示された日銀・FRBの据え置きだけ hold。不明な政策姿勢は
    実際の利上げ・利下げへ読み替えず、政策札を外して本文を保持する。
    成立する辺がなければ単独の札として残す。hold の札からは結ばない。
    """
    result = deepcopy(case)
    result.pop("chain", None)
    node_ids = {n["id"] for n in graph.get("nodes", []) if isinstance(n, dict) and "id" in n}
    label = unicodedata.normalize("NFKC", str(case.get("label") or ""))
    event = unicodedata.normalize("NFKC", str(event or ""))
    raw_paths = case.get("paths")
    if not isinstance(raw_paths, list):
        raw_paths = [case.get("chain", [])]
    raw_paths = [path for path in raw_paths if isinstance(path, list)]
    present_policies = {
        tag.get("node") for path in raw_paths for tag in path
        if isinstance(tag, dict) and isinstance(tag.get("node"), str) and tag["node"] in POLICY_NODES
    }
    # 主体が複数で決定内容の対応が曖昧な場合も推測しない。
    relevant = _actors(event) or _actors(label) or present_policies
    relevant = relevant if len(relevant) == 1 else set()
    policy_dir = _policy_direction(label)
    edges = {}
    for edge in graph.get("edges", []):
        if isinstance(edge, dict) and edge.get("sign") in {1, -1}:
            edges.setdefault((edge.get("from"), edge.get("to")), set()).add(edge["sign"])
    paths = []
    keys = set()
    for raw in raw_paths:
        tags = _tags(raw, node_ids, policy_dir, relevant)
        for path in _split_paths(tags, edges):
            key = _path_key(path)
            if key not in keys:
                keys.add(key)
                paths.append(path)
    # 別の経路の一部だけを重複表示する札・近道も省く。
    result["paths"] = [
        path for path in paths
        if not any(len(other) > len(path) and _subsequence(_path_key(path), _path_key(other)) for other in paths)
    ]
    return result
