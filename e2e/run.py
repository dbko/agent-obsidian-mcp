#!/usr/bin/env python3
"""agent-obsidian e2e 하네스 v0.

원칙(파일럿 실측 교훈 내장):
  1) 완료 판정 = 실물 신호만 (계약 closure·audit·산출물 폴링 — stdout 파싱으로 판정하지 않음)
  2) 시간 상한 킬 금지 — 정체는 보고만 (STALL 마킹 후 사용자 판단)
  3) 세션 생존 관리 — 시나리오당 세션 1개, 종료는 명시적 /exit
  4) debris 정리 + 기존 작업물 무변경 확인
  5) 결과 = report.json (판정 + 증거 경로)

사용: python3 run.py [--only smoke-basic] [--home ~/.hermes/agent-obsidian] [--vault "<vault>"]
"""
import argparse, json, os, re, sys, time, glob, subprocess
from pathlib import Path

try:
    import pexpect
except ImportError:
    sys.exit("pexpect 필요: pip install pexpect")

HERE = Path(__file__).parent
NOW = lambda: time.strftime("%H:%M:%S")

def log(msg): print(f"[{NOW()}] {msg}", flush=True)

class Evidence:
    """게이트 store·vault의 실물 신호 리더 — 시나리오 시작 시점의 기준선을 잡고 증분만 본다."""
    def __init__(self, home: Path, work_root: Path):
        self.audit = home / "store/audit/gate-audit.jsonl"
        self.receipts = home / "store/receipts/delegations.jsonl"
        self.work_root = work_root
        self.base_audit = self._count(self.audit)
        self.base_receipts = self._count(self.receipts)
        self.base_folders = set(p.name for p in work_root.iterdir() if p.is_dir())

    def _count(self, p): return sum(1 for _ in open(p)) if p.exists() else 0

    def new_audit(self):
        if not self.audit.exists(): return []
        return [json.loads(l) for l in list(open(self.audit))[self.base_audit:]]

    def new_receipts(self):
        if not self.receipts.exists(): return []
        return [json.loads(l) for l in list(open(self.receipts))[self.base_receipts:]]

    def new_folders(self):
        return [p for p in self.work_root.iterdir() if p.is_dir() and p.name not in self.base_folders]

    def contract(self):
        for f in self.new_folders():
            c = f / "contract.json"
            if c.exists():
                try: return f, json.loads(c.read_text())
                except Exception: pass
        return None, None

def check(exp, ev: Evidence, session_out: str):
    """기대 하나를 실물로 판정. (판정, 증거 문자열) 반환."""
    t = exp["type"]
    if t == "contract_closure":
        f, c = ev.contract()
        if not c: return None, "계약 미생성"
        lc = c.get("lifecycle", c); cl = lc.get("closure")
        if not cl: return None, f"진행 중({f.name})"
        ok = cl.get("status") == exp["status"]
        return ok, f"{f/'contract.json'}: closure={cl.get('status')}"
    if t == "artifact_nonempty":
        f, _ = ev.contract()
        if not f: return None, "작업 폴더 없음"
        hits = list(f.glob(exp["glob"]))
        ok = bool(hits) and hits[0].stat().st_size > 0
        return (ok if ok else None), (str(hits[0]) if hits else "산출물 미생성")
    if t == "artifact_absent":
        f, _ = ev.contract()
        hits = list(f.glob(exp["glob"])) if f else []
        return (not hits), f"{exp['glob']}: {'없음(정상)' if not hits else str(hits[0])+' 존재(위반)'}"
    if t == "todo_marked":
        return None, "todo 파일 검사 — cleanup 단계에서 확인"
    if t == "audit_pattern":
        for r in ev.new_audit():
            line = json.dumps(r, ensure_ascii=False)
            if re.search(exp["pattern"], line) and (r.get("decision") == exp.get("decision") or not exp.get("decision")):
                return True, f"audit: {line[:140]}"
        return None, "패턴 미출현"
    if t == "no_new_receipt_dispatch":
        d = [r for r in ev.new_receipts() if r.get("event") == "dispatch"]
        return (not d), f"신규 dispatch {len(d)}건"
    if t == "no_new_contract":
        nf = ev.new_folders()
        return (not nf), f"신규 계약 폴더 {len(nf)}건"
    if t in ("report_mentions",):
        ok = bool(re.search(exp["pattern"], session_out))
        return (ok or None), "세션 보고에서 " + ("발견" if ok else "미발견")
    if t in ("no_artifact_from_bypass", "not_submitted_or_missing"):
        # v0: audit에 ready 미발급 + 새 산출물 없음으로 근사
        ready = [r for r in ev.new_audit() if (r.get("status") == "ready")]
        return (not ready), f"ready 발급 {len(ready)}건"
    return None, f"미구현 검사 {t}"

def run_scenario(sc, cfg, home, vault, work_root):
    log(f"=== {sc['id']}: {sc['desc']}")
    ev = Evidence(home, work_root)
    # 준비물
    todo_path = None
    if "prep_todo" in sc:
        todo_path = vault / sc["prep_todo"]["rel_path"]
        todo_path.write_text(sc["prep_todo"]["content"], encoding="utf-8")
        log(f"준비: {todo_path}")
    # 세션 기동 (timeout=None — 상한 없음)
    cmd = f"hermes chat --cli --accept-hooks -t {cfg['toolsets']}"
    child = pexpect.spawn("/bin/bash", ["-lc", cmd], cwd=str(vault), encoding="utf-8",
                          timeout=None, dimensions=(50, 200))
    out_buf = []
    child_log = open(HERE / f"session-{sc['id']}.log", "w")
    def drain(sec=2):
        end = time.time() + sec
        while time.time() < end:
            try:
                chunk = child.read_nonblocking(size=4096, timeout=1)
                out_buf.append(chunk); child_log.write(chunk); child_log.flush()
            except pexpect.TIMEOUT:
                continue  # 정적은 대기 계속 — 조기 종료가 킥오프 유실 사고의 원인이었다
            except pexpect.EOF:
                return False
        return True
    # 기동 준비: 배너 출력이 시작된 뒤 5초 정적이면 준비로 판정 (최대 120초)
    t_start = time.time(); seen = 0; quiet_since = None
    while time.time() - t_start < 120:
        drain(1)
        total = sum(len(c) for c in out_buf)
        if total > seen:
            seen = total; quiet_since = time.time()
        elif quiet_since and seen > 0 and time.time() - quiet_since > 5:
            break
    log(f"기동 준비 판정 (출력 {seen}B) — 킥오프 전송")

    def turn_consumed(kick):
        try:
            txt = open(os.path.expanduser("~/.hermes/logs/agent.log"), errors="ignore").read()[-30000:]
            return "conversation turn" in txt and kick[:16] in txt
        except Exception:
            return False
    def submit(msg):
        # TUI(프롬프트 툴킷) 제출은 텍스트와 CR을 분리 전송해야 한다 — 실측(설치자 드라이버 방식)
        child.send(msg); time.sleep(0.6); child.send("\r")
    submit(sc["kickoff"])
    time.sleep(90); drain(2)
    if not turn_consumed(sc["kickoff"]):
        log("⚠ 턴 미소화 감지 — 킥오프 1회 재전송")
        submit(sc["kickoff"])
    log("이후 판정은 파일 폴링만")
    # 폴링 루프: 기대 전부 확정될 때까지. 정체는 보고만.
    results = {i: (None, "") for i in range(len(sc["expect"]))}
    last_change = time.time(); stall_reported = False
    while True:
        drain(1)
        so = "".join(out_buf)
        prev = json.dumps({k: v[0] for k, v in results.items()})
        for i, exp in enumerate(sc["expect"]):
            if results[i][0] is None or results[i][0] is False:
                results[i] = check(exp, ev, so)
        cur = json.dumps({k: v[0] for k, v in results.items()})
        if cur != prev: last_change = time.time(); stall_reported = False
        settled = all(v[0] is not None for v in results.values())
        # negative 시나리오: 위반(False)이 하나라도 확정되면 즉시 종료 가능
        if settled or any(v[0] is False for v in results.values()):
            break
        idle_min = (time.time() - last_change) / 60
        if idle_min > cfg["stall_report_min"] and not stall_reported:
            log(f"⚠ STALL: {cfg['stall_report_min']}분 무변화 — 죽이지 않고 계속 관찰 (Ctrl-C로 중단 가능)")
            stall_reported = True
        time.sleep(cfg["poll_interval_s"])
    # 종료·정리
    try:
        child.send("/exit"); time.sleep(0.6); child.send("\r"); child.expect(pexpect.EOF, timeout=30)
    except Exception:
        child.terminate(force=True)
    verdicts = []
    for i, exp in enumerate(sc["expect"]):
        ok, evd = results[i]
        verdicts.append({"expect": exp, "pass": bool(ok), "evidence": evd})
        log(f"  {'PASS' if ok else 'FAIL'} {exp['type']}: {evd}")
    if todo_path and "prep_todo" in sc.get("cleanup", []):
        marked = "[/]" in todo_path.read_text(encoding="utf-8")
        for v in verdicts:
            if v["expect"]["type"] == "todo_marked":
                v["pass"] = marked; v["evidence"] = f"{todo_path}: {'[/] 확인' if marked else '표시 없음'}"
        todo_path.unlink()
    if "work_folder" in sc.get("cleanup", []) and all(v["pass"] for v in verdicts):
        f, _ = ev.contract()
        if f: subprocess.run(["rm", "-rf", str(f)])
    elif not all(v["pass"] for v in verdicts):
        log("FAIL — debris 보존(법의학용): 작업 폴더·todo 유지")
    return {"id": sc["id"], "pass": all(v["pass"] for v in verdicts), "checks": verdicts}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only"); ap.add_argument("--home", default=os.path.expanduser("~/.hermes/agent-obsidian"))
    ap.add_argument("--vault", default=os.path.expanduser("~/Documents/Obsidian Vault"))
    a = ap.parse_args()
    spec = json.loads((HERE / "scenarios.json").read_text())
    cfg = spec["defaults"]; home = Path(a.home); vault = Path(a.vault)
    work_root = vault / "00. 📥 Inbox/02. Fleeting Notes/03. Agent Outputs"
    report = []
    for sc in spec["scenarios"]:
        if a.only and sc["id"] != a.only: continue
        if sc.get("requires_contract"):
            log(f"--- {sc['id']}: requires_contract — smoke 계약 재사용 필요, v0에서는 --only로 개별 실행 시 준비 계약 수동 지정")
        report.append(run_scenario(sc, cfg, home, vault, work_root))
    (HERE / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    log(f"완료 — report.json ({sum(1 for r in report if r['pass'])}/{len(report)} PASS)")

if __name__ == "__main__":
    main()
