"""Build the Meaning Map embedding corpus from O*NET 30.3 text files.
Implements ticket 01's recipe, reconciled against real v30.3 file structure:
  embed_text = Description + Core Tasks + top-10 Essential Skills + top-10 Knowledge + top-10 Work Activities (IM)
  NEVER the title.
Outputs corpus.jsonl (one occupation per line).
"""
import csv, json, re, sys
from collections import defaultdict

DB = sys.argv[1]  # path to db_30_3_text dir
OUT = sys.argv[2]

SOC_MAJOR = {
    "11": "Management", "13": "Business & Financial Operations",
    "15": "Computer & Mathematical", "17": "Architecture & Engineering",
    "19": "Life, Physical & Social Science", "21": "Community & Social Service",
    "23": "Legal", "25": "Educational Instruction & Library",
    "27": "Arts, Design, Entertainment, Sports & Media",
    "29": "Healthcare Practitioners & Technical", "31": "Healthcare Support",
    "33": "Protective Service", "35": "Food Preparation & Serving",
    "37": "Building & Grounds Cleaning & Maintenance", "39": "Personal Care & Service",
    "41": "Sales & Related", "43": "Office & Administrative Support",
    "45": "Farming, Fishing & Forestry", "47": "Construction & Extraction",
    "49": "Installation, Maintenance & Repair", "51": "Production",
    "53": "Transportation & Material Moving", "55": "Military Specific",
}

def rows(name):
    with open(f"{DB}/{name}", encoding="utf-8", newline="") as f:
        yield from csv.DictReader(f, delimiter="\t")

# 1. Occupation Data: code -> (title, description)
occ = {}
for r in rows("Occupation Data.txt"):
    occ[r["O*NET-SOC Code"]] = {"title": r["Title"], "description": r["Description"]}

# 2. Core tasks in file order
tasks = defaultdict(list)
for r in rows("Task Statements.txt"):
    if r["Task Type"] == "Core":
        tasks[r["O*NET-SOC Code"]].append(r["Task"])

# 3. Top-N by Importance (IM) helper for descriptor files
def top_im(name, n=10):
    buf = defaultdict(list)
    for r in rows(name):
        if r["Scale ID"] == "IM":
            buf[r["O*NET-SOC Code"]].append((float(r["Data Value"]), r["Element Name"]))
    out = {}
    for code, lst in buf.items():
        lst.sort(key=lambda t: -t[0])
        out[code] = [name for _, name in lst[:n]]
    return out

skills = top_im("Essential Skills.txt")      # v30.3 successor to old Skills.txt (2.A Basic + 2.B Cross-Functional)
knowledge = top_im("Knowledge.txt")
workact = top_im("Work Activities.txt")

# job zones
jz = {}
for r in rows("Job Zones.txt"):
    jz[r["O*NET-SOC Code"]] = int(r["Job Zone"])

# data-level = has ALL descriptor components (fully embeddable per the recipe)
codes = sorted(set(tasks) & set(skills) & set(knowledge) & set(workact) & set(occ))

def first_sentence(desc, cap=160):
    m = re.split(r"(?<=[.!?])\s", desc, maxsplit=1)
    s = m[0].strip()
    return s if len(s) <= cap else desc[:cap].rstrip() + "…"

def soc6(code):  # 11-1011.00 -> 11-1011
    return code.split(".")[0]

n_written = 0
with open(OUT, "w", encoding="utf-8") as out:
    for code in codes:
        o = occ[code]
        mg2 = code[:2]
        parts = [o["description"]]
        parts += tasks[code]
        parts.append("Skills: " + ", ".join(skills[code]) + ".")
        parts.append("Knowledge: " + ", ".join(knowledge[code]) + ".")
        parts.append("Work activities: " + ", ".join(workact[code]) + ".")
        embed_text = " ".join(p.strip() for p in parts if p.strip())
        rec = {
            "code": code,
            "soc6": soc6(code),
            "title": o["title"],
            "short_description": first_sentence(o["description"]),
            "major_group": SOC_MAJOR.get(mg2, "Other"),
            "major_group_code": mg2,
            "job_zone": jz.get(code),
            "n_core_tasks": len(tasks[code]),
            "embed_text": embed_text,
        }
        out.write(json.dumps(rec, ensure_ascii=False) + "\n")
        n_written += 1

print(f"occupations in Occupation Data: {len(occ)}")
print(f"fully-embeddable (all descriptors): {len(codes)}")
print(f"written: {n_written}")
lens = []
for code in codes:
    pass
# quick embed_text length stats
import statistics
with open(OUT, encoding="utf-8") as f:
    lens = [len(json.loads(l)["embed_text"]) for l in f]
print(f"embed_text chars: min={min(lens)} median={int(statistics.median(lens))} max={max(lens)}")
# major-group distribution
mg = defaultdict(int)
with open(OUT, encoding="utf-8") as f:
    for l in f:
        mg[json.loads(l)["major_group"]] += 1
print("major groups:", len(mg))
for k in sorted(mg, key=lambda k: -mg[k]):
    print(f"  {mg[k]:4d}  {k}")
