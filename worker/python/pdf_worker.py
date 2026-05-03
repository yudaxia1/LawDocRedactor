import argparse
import base64
import io
import json
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path

from pdfminer.high_level import extract_pages
from pdfminer.layout import LTChar, LTTextLine
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, NameObject
from reportlab.pdfgen import canvas


@dataclass(frozen=True)
class Rule:
    category: str
    name: str
    replacement: str
    regex: re.Pattern
    use_capture_group: bool


def load_rules(rules_path: Path) -> list[Rule]:
    raw = json.loads(rules_path.read_text(encoding="utf-8"))
    rules = raw.get("rules", [])
    rules = [r for r in rules if r and r.get("enabled", True) and isinstance(r.get("patterns"), list)]
    rules.sort(key=lambda r: r.get("priority", 0), reverse=True)

    compiled: list[Rule] = []
    for r in rules:
        for p in r.get("patterns", []):
            try:
                compiled.append(
                    Rule(
                        category=r.get("category") or r.get("id") or "unknown",
                        name=r.get("name") or r.get("category") or r.get("id") or "未知",
                        replacement=r.get("replacement") or "【敏感信息${index}】",
                        regex=re.compile(p),
                        use_capture_group=bool(r.get("useCaptureGroup")),
                    )
                )
            except re.error:
                continue
    return compiled


def build_replacement(template: str, index: int) -> str:
    return template.replace("${index}", str(index))


def iter_textlines(layout):
    for obj in layout:
        if isinstance(obj, LTTextLine):
            yield obj
        if hasattr(obj, "__iter__"):
            yield from iter_textlines(obj)


def textline_chars(line: LTTextLine):
    chars = []
    for obj in line:
        if isinstance(obj, LTChar):
            chars.append((obj.get_text(), obj.bbox))
        else:
            t = getattr(obj, "get_text", None)
            if callable(t):
                chars.append((t(), None))
    return chars


def union_bbox(boxes):
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes)
    y1 = max(b[3] for b in boxes)
    return (x0, y0, x1, y1)


def find_redactions_in_pdf(input_pdf: Path, rules: list[Rule]):
    replacement_map: dict[str, str] = {}
    counters: dict[str, int] = {}
    redactions: list[dict] = []

    for page_index, layout in enumerate(extract_pages(str(input_pdf))):
        for line in iter_textlines(layout):
            chars = textline_chars(line)
            text = "".join(c[0] for c in chars)
            if not text.strip():
                continue

            for rule in rules:
                for m in rule.regex.finditer(text):
                    if not m.group(0):
                        continue

                    start = m.start()
                    end = m.end()
                    original = m.group(0)

                    if rule.use_capture_group:
                        for gi in range(1, len(m.groups()) + 1):
                            g = m.group(gi)
                            if g:
                                original = g
                                start = m.start(gi)
                                end = m.end(gi)
                                break

                    if original not in replacement_map:
                        idx = counters.get(rule.category, 1)
                        replacement_map[original] = build_replacement(rule.replacement, idx)
                        counters[rule.category] = idx + 1

                    bbox_chars = [c[1] for c in chars[start:end] if c[1] is not None]
                    if not bbox_chars:
                        continue

                    bbox = union_bbox(bbox_chars)
                    redactions.append(
                        {
                            "page": page_index,
                            "bbox": [bbox[0], bbox[1], bbox[2], bbox[3]],
                            "original": original,
                            "replacement": replacement_map[original],
                            "type": rule.name,
                        }
                    )

    redactions.sort(key=lambda r: (r["page"], -(len(r["original"]))))
    return redactions


def build_overlay_pdf(page_width, page_height, items):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(page_width, page_height))
    c.setFillColorRGB(1, 1, 1)
    c.setStrokeColorRGB(1, 1, 1)
    c.setFont("Helvetica", 10)

    for it in items:
        x0, y0, x1, y1 = it["bbox"]
        pad = 1
        c.rect(x0 - pad, y0 - pad, (x1 - x0) + pad * 2, (y1 - y0) + pad * 2, fill=1, stroke=0)
        c.setFillColorRGB(0, 0, 0)
        c.drawString(x0, y0, it["replacement"])
        c.setFillColorRGB(1, 1, 1)

    c.showPage()
    c.save()
    buf.seek(0)
    return buf.getvalue()


def redact_pdf(input_pdf: Path, output_pdf: Path, sidecar_zip: Path, rules_path: Path):
    rules = load_rules(rules_path)
    redactions = find_redactions_in_pdf(input_pdf, rules)

    reader = PdfReader(str(input_pdf))
    writer = PdfWriter()

    for i, page in enumerate(reader.pages):
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)
        overlay_items = [r for r in redactions if r["page"] == i]
        if overlay_items:
            overlay_bytes = build_overlay_pdf(width, height, overlay_items)
            overlay_reader = PdfReader(io.BytesIO(overlay_bytes))
            page.merge_page(overlay_reader.pages[0])
        writer.add_page(page)

    with open(output_pdf, "wb") as f:
        writer.write(f)

    sidecar_data = {"version": 1, "rules": str(rules_path.name), "redactions": redactions}
    with zipfile.ZipFile(sidecar_zip, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("mapping.json", json.dumps(sidecar_data, ensure_ascii=False, indent=2))
        z.writestr("original.pdf", input_pdf.read_bytes())

    return len(redactions)


def restore_pdf(input_pdf: Path, output_pdf: Path, sidecar_zip: Path):
    with zipfile.ZipFile(sidecar_zip, "r") as z:
        original_bytes = z.read("original.pdf")

    original_reader = PdfReader(io.BytesIO(original_bytes))
    redacted_reader = PdfReader(str(input_pdf))

    writer = PdfWriter()
    writer.clone_document_from_reader(original_reader)

    for idx, orig_page in enumerate(writer.pages):
        if idx >= len(redacted_reader.pages):
            break
        red_page = redacted_reader.pages[idx]
        annots = red_page.get("/Annots")
        if not annots:
            continue

        combined = ArrayObject()
        existing = orig_page.get("/Annots")
        if existing:
            for a in existing:
                combined.append(a)

        for a in annots:
            try:
                obj = a.get_object()
                combined.append(writer._add_object(obj))
            except Exception:
                continue

        orig_page[NameObject("/Annots")] = combined

    with open(output_pdf, "wb") as f:
        writer.write(f)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_redact = sub.add_parser("redact")
    p_redact.add_argument("--input", required=True)
    p_redact.add_argument("--output", required=True)
    p_redact.add_argument("--sidecar", required=True)
    p_redact.add_argument("--rules", required=True)

    p_restore = sub.add_parser("restore")
    p_restore.add_argument("--input", required=True)
    p_restore.add_argument("--output", required=True)
    p_restore.add_argument("--sidecar", required=True)

    args = parser.parse_args()

    if args.cmd == "redact":
        count = redact_pdf(
            Path(args.input),
            Path(args.output),
            Path(args.sidecar),
            Path(args.rules),
        )
        print(json.dumps({"count": count}, ensure_ascii=False))
        return

    if args.cmd == "restore":
        restore_pdf(Path(args.input), Path(args.output), Path(args.sidecar))
        print(json.dumps({"ok": True}, ensure_ascii=False))
        return


if __name__ == "__main__":
    main()

