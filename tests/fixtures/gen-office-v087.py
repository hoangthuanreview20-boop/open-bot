#!/usr/bin/env python3
"""Generate the real office fixtures for tests/read-file-office-v087.test.mjs.

Run with the venv that has openpyxl, pillow, pikepdf, msoffcrypto:
  /tmp/venv-crypto/bin/python tests/fixtures/gen-office-v087.py

Outputs (all small, committed to tests/fixtures/):
  read-file-v087-sample.docx   heading + paragraph + 2x3 table + page 2
  read-file-v087-sample.pdf    the same DOCX converted by LibreOffice (2 pages)
  read-file-v087-sample.xlsx   2 sheets (Summary, Details) via openpyxl
  read-file-v087-scanned.pdf   image-only page (no text layer) via pikepdf
  read-file-v087-corrupt.{pdf,docx,xlsx}
  read-file-v087-encrypted.{pdf,docx,xlsx}  password "test123" (see below)

The DOCX is a minimal valid OOXML zip (hand-written document.xml) — it
opens in LibreOffice and Word; the PDF is produced from it by LibreOffice
so the PDF has a real-world structure instead of a hand-built one. The
password-protected files use pikepdf (PDF, Standard security handler) and
msoffcrypto-tool (OOXML, agile encryption) — the same formats real apps
produce. Fixture passwords are the literal string "test123" and are only
used to prove the fail-closed error path; they protect nothing real.
"""
import os
import random
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PASSWORD = "test123"

# ---------------------------------------------------------------- DOCX
CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"""
RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"""
DOCUMENT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Open-Bot Office Fixture</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Section One</w:t></w:r></w:p>
<w:p><w:r><w:t>Hello from the DOCX fixture. This paragraph tests plain text extraction.</w:t></w:r></w:p>
<w:p><w:r><w:t>Xin chao open-bot - Vietnamese text survives extraction.</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Alpha</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Beta</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<!--FILLER-->
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Page Two</w:t></w:r></w:p>
<w:p><w:r><w:t>Second page content for the PDF test.</w:t></w:r></w:p>
</w:body></w:document>"""


def build_document_xml():
    # Enough filler lines that the LibreOffice PDF spills onto a second page.
    filler = "".join(
        f'<w:p><w:r><w:t>Filler line {n} to push the document onto a second page.</w:t></w:r></w:p>\n'
        for n in range(1, 61)
    )
    return DOCUMENT.replace("<!--FILLER-->", filler)


def write_docx(path):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/document.xml", build_document_xml())


def main():
    import subprocess
    import msoffcrypto
    import openpyxl
    import pikepdf
    from PIL import Image, ImageDraw

    docx = os.path.join(HERE, "read-file-v087-sample.docx")
    write_docx(docx)

    # PDF: the same DOCX converted by LibreOffice (real-world structure,
    # 2 pages because the DOCX has a page break).
    pdf = os.path.join(HERE, "read-file-v087-sample.pdf")
    subprocess.run(
        ["soffice", "--headless", "--convert-to", "pdf", "--outdir", HERE, docx],
        check=True, capture_output=True, text=True,
    )
    assert os.path.exists(pdf), "LibreOffice did not produce the sample PDF"

    # XLSX: 2 sheets via openpyxl.
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Summary"
    ws.append(["Item", "Qty"])
    ws.append(["Apple", 10])
    ws.append(["Banana", 20])
    ws2 = wb.create_sheet("Details")
    ws2.append(["City", "Note"])
    ws2.append(["Hanoi", "Capital"])
    ws2.append(["Saigon", "Big city"])
    xlsx = os.path.join(HERE, "read-file-v087-sample.xlsx")
    wb.save(xlsx)

    # Scanned PDF: one page that is only an image, no text layer.
    img = Image.new("RGB", (400, 200), "white")
    draw = ImageDraw.Draw(img)
    draw.text((20, 90), "This is a scanned page", fill="black")
    raw = img.tobytes()
    scan_pdf = pikepdf.Pdf.new()
    page = scan_pdf.add_blank_page(page_size=(400, 200))
    image = scan_pdf.make_indirect(
        pikepdf.Stream(
            scan_pdf,
            raw,
            Type=pikepdf.Name("/XObject"),
            Subtype=pikepdf.Name("/Image"),
            Width=400,
            Height=200,
            BitsPerComponent=8,
            ColorSpace=pikepdf.Name("/DeviceRGB"),
        )
    )
    page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im1=image))
    page.Contents = scan_pdf.make_indirect(
        pikepdf.Stream(scan_pdf, b"q 400 0 0 200 0 0 cm /Im1 Do Q")
    )
    scan_pdf.save(os.path.join(HERE, "read-file-v087-scanned.pdf"))

    # Encrypted PDF (user password "test123") via pikepdf.
    src = pikepdf.Pdf.open(pdf)
    src.save(
        os.path.join(HERE, "read-file-v087-encrypted.pdf"),
        encryption=pikepdf.Encryption(owner="owner123", user=PASSWORD, R=4),
    )
    src.close()

    # Encrypted OOXML via msoffcrypto-tool (agile encryption, like Word/Excel).
    for name in ("sample.docx", "sample.xlsx"):
        src_path = os.path.join(HERE, "read-file-v087-" + name)
        dst_path = os.path.join(HERE, "read-file-v087-encrypted." + name.split(".")[1])
        with open(src_path, "rb") as f:
            office = msoffcrypto.OfficeFile(f)
            with open(dst_path, "wb") as out:
                office.encrypt(PASSWORD, out)

    # Corrupt fixtures: truncated real files / random bytes.
    rng = random.Random(42)
    with open(pdf, "rb") as f:
        pdf_bytes = f.read()
    with open(os.path.join(HERE, "read-file-v087-corrupt.pdf"), "wb") as f:
        f.write(pdf_bytes[:200])
    with open(os.path.join(HERE, "read-file-v087-corrupt.docx"), "wb") as f:
        f.write(bytes(rng.randrange(256) for _ in range(128)))
    with open(xlsx, "rb") as f:
        xlsx_bytes = f.read()
    with open(os.path.join(HERE, "read-file-v087-corrupt.xlsx"), "wb") as f:
        f.write(xlsx_bytes[:100])


if __name__ == "__main__":
    main()
