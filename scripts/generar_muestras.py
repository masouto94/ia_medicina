"""Genera los archivos de prueba de la carpeta /muestras (fotos ilustrativas e informe ficticio)."""
import json
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

OUT = os.path.join(os.path.dirname(__file__), "..", "muestras")
os.makedirs(OUT, exist_ok=True)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
MONO_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
random.seed(7)


def f(size, bold=False, mono=False):
    return ImageFont.truetype(MONO_B if mono else (FONT_B if bold else FONT), size)


def table_bg(w, h, base=(196, 170, 135)):
    img = Image.new("RGB", (w, h), base)
    d = ImageDraw.Draw(img)
    for y in range(0, h, 6):  # vetas de madera
        c = tuple(max(0, min(255, v + random.randint(-12, 12))) for v in base)
        d.line([(0, y), (w, y + random.randint(-8, 8))], fill=c, width=4)
    return img.filter(ImageFilter.GaussianBlur(1.5))


def finish(img, name, angle=0):
    if angle:
        img = img.rotate(angle, resample=Image.BICUBIC, fillcolor=img.getpixel((5, 5)))
    # leve ruido y desenfoque, como una foto de celular
    px = img.load()
    for _ in range(img.width * img.height // 25):
        x, y = random.randrange(img.width), random.randrange(img.height)
        r, g, b = px[x, y]
        n = random.randint(-14, 14)
        px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    img.save(os.path.join(OUT, name), quality=88)


def glucometro(valor, name, hora="07:32"):
    img = table_bg(900, 1100)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([200, 120, 700, 1000], 90, fill=(232, 236, 240), outline=(150, 155, 165), width=6)
    d.rounded_rectangle([250, 200, 650, 560], 30, fill=(60, 64, 72))
    d.rounded_rectangle([275, 225, 625, 535], 18, fill=(178, 196, 168))  # LCD
    d.text((300, 245), f"{hora}   05/10", font=f(30, mono=True), fill=(40, 50, 40))
    d.text((450, 380), str(valor), font=f(150, mono=True), fill=(25, 30, 25), anchor="mm")
    d.text((560, 500), "mg/dL", font=f(30, bold=True), fill=(25, 30, 25), anchor="mm")
    d.text((450, 640), "GLUCO-DEMO", font=f(40, bold=True), fill=(70, 90, 140), anchor="mm")
    for cx in (360, 540):
        d.ellipse([cx - 55, 760, cx + 55, 870], fill=(200, 205, 212), outline=(140, 145, 155), width=4)
    d.rectangle([420, 990, 480, 1060], fill=(245, 245, 235), outline=(150, 150, 140))  # tira reactiva
    finish(img, name, angle=random.uniform(-6, 6))


def tensiometro(sis, dia, pul, name):
    img = table_bg(1100, 900, base=(210, 210, 205))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([150, 120, 950, 780], 70, fill=(245, 246, 248), outline=(160, 160, 170), width=6)
    d.rounded_rectangle([230, 180, 870, 600], 24, fill=(195, 210, 200))
    d.text((260, 200), "SYS mmHg", font=f(30, bold=True), fill=(40, 40, 40))
    d.text((840, 290), str(sis), font=f(130, mono=True), fill=(20, 20, 20), anchor="rm")
    d.text((260, 390), "DIA mmHg", font=f(30, bold=True), fill=(40, 40, 40))
    d.text((840, 450), str(dia), font=f(110, mono=True), fill=(20, 20, 20), anchor="rm")
    d.text((260, 530), f"PUL/min  {pul}", font=f(34, mono=True), fill=(40, 40, 40))
    d.ellipse([480, 640, 620, 760], fill=(60, 110, 190))
    d.text((550, 700), "START", font=f(24, bold=True), fill="white", anchor="mm")
    d.text((270, 690), "TENSIO-DEMO", font=f(30, bold=True), fill=(90, 90, 110))
    finish(img, name, angle=random.uniform(-4, 4))


def blister(nombre, dosis, name, color=(255, 255, 255)):
    img = table_bg(1100, 800, base=(150, 160, 175))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([120, 120, 980, 680], 30, fill=(205, 208, 214), outline=(160, 165, 170), width=4)
    for i in range(5):
        for j in range(2):
            cx, cy = 230 + i * 160, 300 + j * 220
            d.ellipse([cx - 60, cy - 60, cx + 60, cy + 60], fill=(225, 228, 232), outline=(170, 175, 180), width=3)
            if not (i == 0 and j == 0):
                d.ellipse([cx - 42, cy - 28, cx + 42, cy + 28], fill=color, outline=(200, 200, 200))
    d.rectangle([120, 120, 980, 200], fill=(240, 240, 244))
    d.text((550, 160), f"{nombre.upper()} {dosis}", font=f(46, bold=True), fill=(30, 60, 140), anchor="mm")
    d.text((550, 650), f"{nombre} {dosis} · Comprimidos · Lote D3M0 · Venta bajo receta", font=f(24), fill=(70, 70, 80), anchor="mm")
    finish(img, name, angle=random.uniform(-8, 8))


def pie(name):
    """Ilustración esquemática (no fotográfica) de un pie con una pequeña lesión."""
    img = Image.new("RGB", (900, 1100), (232, 238, 244))
    d = ImageDraw.Draw(img)
    skin = (232, 190, 160)
    d.ellipse([260, 300, 640, 1050], fill=skin, outline=(190, 150, 120), width=4)
    for i, (x, r) in enumerate([(300, 62), (390, 52), (470, 48), (545, 44), (610, 38)]):
        d.ellipse([x - r, 230 - i * 4 - r + (i * 18), x + r, 230 + r + (i * 18)], fill=skin, outline=(190, 150, 120), width=4)
    d.ellipse([400, 520, 470, 580], fill=(205, 95, 85), outline=(170, 70, 65), width=3)  # zona enrojecida
    d.ellipse([423, 538, 447, 562], fill=(230, 200, 190))
    d.text((450, 1075), "Imagen ilustrativa – demo", font=f(26), fill=(110, 120, 130), anchor="mm")
    finish(img, name)


def informe_pdf(name):
    path = os.path.join(OUT, name)
    c = canvas.Canvas(path, pagesize=A4)
    W, H = A4
    c.setFillColor(colors.HexColor("#1f4e79"))
    c.rect(0, H - 32 * mm, W, 32 * mm, fill=1, stroke=0)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(18 * mm, H - 17 * mm, "LABORATORIO DE ANÁLISIS CLÍNICOS DEMO")
    c.setFont("Helvetica", 9)
    c.drawString(18 * mm, H - 24 * mm, "Documento ficticio generado para la demostración académica del asistente · Sin validez clínica")
    c.setFillColor(colors.black)
    y = H - 45 * mm
    c.setFont("Helvetica", 10)
    for k, v in [("Paciente:", "GONZÁLEZ, Marta"), ("Edad / Sexo:", "62 años / F"), ("Protocolo:", "DEMO-2026-10-0217"), ("Fecha de extracción:", "02/10/2026"), ("Médica solicitante:", "Dra. Lucía Fernández")]:
        c.setFont("Helvetica-Bold", 10)
        c.drawString(18 * mm, y, k)
        c.setFont("Helvetica", 10)
        c.drawString(60 * mm, y, v)
        y -= 6 * mm
    y -= 6 * mm
    c.setFillColor(colors.HexColor("#e8eef5"))
    c.rect(15 * mm, y - 2 * mm, W - 30 * mm, 8 * mm, fill=1, stroke=0)
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 10)
    for x, t in [(18, "Determinación"), (95, "Resultado"), (125, "Unidad"), (150, "Valor de referencia")]:
        c.drawString(x * mm, y, t)
    y -= 10 * mm
    rows = [
        ("Glucemia en ayunas", "168", "mg/dL", "70 – 110"),
        ("Hemoglobina glicosilada (HbA1c)", "8,4", "%", "4,0 – 5,6"),
        ("Creatinina", "0,95", "mg/dL", "0,50 – 1,10"),
        ("Colesterol total", "212", "mg/dL", "< 200"),
        ("Colesterol HDL", "44", "mg/dL", "> 45"),
        ("Colesterol LDL", "131", "mg/dL", "< 100"),
        ("Triglicéridos", "185", "mg/dL", "< 150"),
        ("Microalbuminuria (orina aislada)", "22", "mg/g", "< 30"),
    ]
    c.setFont("Helvetica", 10)
    for r in rows:
        c.drawString(18 * mm, y, r[0])
        flag = r[0].startswith(("Hemoglobina", "Glucemia", "Colesterol total", "Colesterol LDL", "Triglicéridos", "Colesterol HDL"))
        c.setFont("Helvetica-Bold" if flag else "Helvetica", 10)
        c.drawString(95 * mm, y, r[1] + (" *" if flag else ""))
        c.setFont("Helvetica", 10)
        c.drawString(125 * mm, y, r[2])
        c.drawString(150 * mm, y, r[3])
        c.setStrokeColor(colors.HexColor("#d0d7e0"))
        c.line(15 * mm, y - 3 * mm, W - 15 * mm, y - 3 * mm)
        y -= 9 * mm
    c.setFont("Helvetica-Oblique", 8)
    c.drawString(18 * mm, y - 4 * mm, "(*) Valor fuera del rango de referencia del laboratorio. Método HbA1c: HPLC certificado NGSP.")
    c.setFont("Helvetica", 9)
    c.drawString(18 * mm, 30 * mm, "Bioq. (firma ficticia) – Mat. DEMO 0000")
    c.drawString(18 * mm, 24 * mm, "Este documento es un ejemplo de prueba para el simulador. No corresponde a una persona real.")
    c.save()


glucometro(182, "glucometro_182.jpg")
glucometro(48, "glucometro_48.jpg", hora="11:05")
tensiometro(148, 92, 78, "tensiometro_148_92.jpg")
blister("Metformina", "850 mg", "blister_metformina.jpg")
blister("Glibenclamida", "5 mg", "blister_glibenclamida.jpg", color=(250, 240, 200))
pie("foto_pie_lesion.jpg")
informe_pdf("informe_laboratorio.pdf")

muestras = [
    {"archivo": "glucometro_182.jpg", "titulo": "Glucómetro: 182 mg/dl", "esperado": "Lee el valor y registra la glucemia (Observation + Media). Si lo subís a mano, agregá 'en ayunas' como comentario."},
    {"archivo": "glucometro_48.jpg", "titulo": "Glucómetro: 48 mg/dl", "esperado": "Hipoglucemia grave → protocolo de alarma + aviso a la médica."},
    {"archivo": "tensiometro_148_92.jpg", "titulo": "Tensiómetro: 148/92", "esperado": "Registra presión; supera el umbral → alerta baja."},
    {"archivo": "blister_metformina.jpg", "titulo": "Blíster de Metformina 850", "esperado": "Identifica el remedio y confirma que coincide con el plan."},
    {"archivo": "blister_glibenclamida.jpg", "titulo": "Blíster de Glibenclamida 5", "esperado": "Remedio NO indicado → derivación a la médica."},
    {"archivo": "foto_pie_lesion.jpg", "titulo": "Foto de lesión en el pie", "esperado": "No la analiza: se envía a la médica (derivación + DocumentReference)."},
    {"archivo": "informe_laboratorio.pdf", "titulo": "Informe de laboratorio (PDF)", "esperado": "Extrae HbA1c, glucemia, lípidos, creatinina → Observations; HbA1c fuera de meta → alerta."},
]
with open(os.path.join(OUT, "muestras.json"), "w", encoding="utf-8") as fh:
    json.dump(muestras, fh, ensure_ascii=False, indent=2)
print("ok")
