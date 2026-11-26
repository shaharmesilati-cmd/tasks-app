# End-to-end check in a real Chrome. Run: python3 tests/e2e/e2e.py  (needs the app served on http://127.0.0.1:8765)
import re, sys
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8765/index.html"
SECRET = "סוד-ביותר-XYZ"
results = []
def show_all(page):
    if page.locator(".tiles.menu").count():
        page.locator(".tile").filter(has_text="כל המשימות").click(); page.wait_for_selector(".scopehead")

def to_menu(page):
    if page.locator(".scopehead").count():
        page.get_by_label("חזרה למסך הראשי").click(); page.wait_for_selector(".tiles.menu")


def check(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))

def digits(page, s):
    for ch in s:
        page.locator(".keys").get_by_role("button", name=ch, exact=True).click()

def nav(page, i):
    page.locator(".nav button").nth(i).click()

def add_task(page, title, when=None, prio=None, new_cat=None, cat=None):
    page.get_by_role("button", name="משימה חדשה").click()
    page.fill("#newTitle", title)
    if when: page.get_by_role("button", name=when, exact=True).click()
    if prio: page.get_by_role("group", name="עדיפות").get_by_role("button", name=prio, exact=True).click()
    if new_cat:
        page.get_by_role("button", name="+ חדשה").click()
        page.get_by_label("שם הקטגוריה (למשל: פרויקט, יחידה)").fill(new_cat)
        page.get_by_role("button", name="הוסף", exact=True).click()
    if cat: page.get_by_role("group", name="קטגוריה").get_by_role("button", name=cat, exact=True).click()
    page.get_by_role("button", name="הוסף משימה").click()
    page.wait_for_selector("#newTitle", state="detached")

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, locale="he-IL", accept_downloads=True, service_workers="block")
    page = ctx.new_page()
    reqs, errs = [], []
    page.on("request", lambda r: reqs.append(r.url))
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(BASE)

    # ---------- number-pad setup: a 4-digit code is allowed (advice only) ----------
    check("no stray null text on setup", "null" not in page.locator(".lock").inner_text())
    check("lock screen has a number pad (10 digits), no text field", page.locator(".keys button").count() >= 10 and page.locator("input[type=text], input[type=password]").count() == 0)
    page.screenshot(path="/tmp/shots/10-setup-pad.png")
    page.keyboard.press("a"); page.keyboard.press("Z")
    check("letters are ignored", page.locator(".dots i").count() == 0)
    digits(page, "2580")
    page.get_by_role("button", name="המשך", exact=True).click()
    check("short code: advice shown, not blocked", "קוד קצר" in page.get_by_role("dialog").inner_text())
    page.get_by_role("button", name="השתמש בקוד הזה").click()
    digits(page, "2581")
    page.wait_for_selector("#toast >> text=לא זהים", timeout=8000)
    page.wait_for_timeout(500)
    check("mismatch: asked to start over", "לא זהים" in page.locator("#toast").inner_text())
    digits(page, "2580"); page.get_by_role("button", name="המשך", exact=True).click(); page.get_by_role("button", name="השתמש בקוד הזה").click()
    digits(page, "2580")
    check("no-recovery warning shown", "אין שחזור" in page.get_by_role("dialog").inner_text())
    page.get_by_role("button", name="הבנתי, המשך").click()
    page.wait_for_selector(".nav", timeout=20000)
    check("home = all tasks screen", page.locator("h1").first.inner_text() == "המשימות שלי")
    check("empty home explains how to start", "עוד אין משימות" in page.content())
    page.screenshot(path="/tmp/shots/11-home-empty.png")

    # ---------- add tasks through the form ----------
    page.get_by_role("button", name="משימה חדשה").click()
    check("new-task form has when/priority/category/details", all(x in page.content() for x in ["מתי?", "ללא מועד", "עדיפות", "קטגוריה", "פירוט קצר"]))
    page.screenshot(path="/tmp/shots/12-new-form.png", full_page=True)
    page.fill("#newTitle", SECRET); page.keyboard.press("Enter")   # one-step quick add (title + Enter)
    page.wait_for_selector(".tiles")
    check("home is only big buttons: 5 tiles, no task rows", page.locator(".tile").count() == 5 and page.locator("li.card").count() == 0)
    show_all(page)
    check("quick add (title + Enter) lands in 'ללא מועד'", page.locator(".sechead").filter(has_text="ללא מועד").count() == 1)
    add_task(page, "תיקון ציוד", when="היום", prio="דחוף", new_cat="הנדסה ימית")
    add_task(page, "הכנת דוח", when="מחר", cat="הנדסה ימית")
    add_task(page, "פגישה עתידית", when="בעוד שבוע")
    to_menu(page)
    tiles = page.locator(".tile .num").all_inner_texts()
    check("tiles: overdue 0, today 1, 7-days 2, open 4, sub-tasks 0", tiles == ["0", "1", "2", "4", "0"], str(tiles))
    show_all(page)
    check("ALL open tasks visible on home", page.locator("li.card").count() == 4)
    check("sections shown: today / soon / no-date", all(page.locator(".sechead").filter(has_text=t).count() == 1 for t in ["היום", "ב-7 הימים הקרובים", "ללא מועד"]))
    page.screenshot(path="/tmp/shots/13-home-full.png", full_page=True)

    # ---------- completing keeps everything in sync ----------
    page.get_by_role("button", name="סמן כהושלם: תיקון ציוד").click()
    page.wait_for_selector("#toast >> text=הושלמה ועברה")
    check("toast with undo after completing", page.locator("#toast .tbtn").count() == 1)
    check("completed task left open lists", page.locator("li.card").filter(has_text="תיקון ציוד").count() == 0)
    to_menu(page)
    check("tiles updated (today 0, open 3)", page.locator(".tile .num").all_inner_texts()[1] == "0" and page.locator(".tile .num").all_inner_texts()[3] == "3")
    nav(page, 2)
    check("completed task is listed in 'הושלמו'", page.locator("li.card").filter(has_text="תיקון ציוד").count() == 1)
    page.screenshot(path="/tmp/shots/14-closed.png")
    page.get_by_role("button", name="פתח מחדש: תיקון ציוד").click()
    check("reopening from 'הושלמו' works", page.locator("li.card").count() == 0)
    nav(page, 0)
    check("reopened task counted under today", page.locator(".tile .num").all_inner_texts()[1] == "1")
    show_all(page)
    check("reopened task back on home", page.locator("li.card").filter(has_text="תיקון ציוד").count() == 1)
    page.get_by_role("button", name="סמן כהושלם: תיקון ציוד").click(); page.wait_for_selector("#toast >> text=הושלמה ועברה"); page.locator("#toast .tbtn").click()
    check("undo from toast restores it", page.locator("li.card").filter(has_text="תיקון ציוד").count() == 1)

    # ---------- sub-tasks: done / not done / cancelled with reason ----------
    page.locator("button.open").filter(has_text=SECRET).click()
    check("detail shows sub-tasks before details", page.content().index("תתי-משימות") < page.content().index("פרטי המשימה"))
    for s in ["שלב א", "שלב ב", "שלב ג"]:
        page.fill("#subAdd", s); page.keyboard.press("Enter"); page.wait_for_selector("#subAdd:focus")
    page.get_by_label(re.compile("^לא בוצע: שלב א")).click()
    page.get_by_label("פרטי תת-משימה").nth(1).click()
    page.get_by_role("group", name="מצב תת-משימה").nth(0).get_by_role("button", name="בוטל").click()
    page.get_by_label("הערה או סיבה").first.fill("הספק ביטל את ההזמנה"); page.get_by_label("הערה או סיבה").first.blur()
    hdr = page.locator("h2.sec").filter(has_text="תתי-משימות").inner_text()
    check("progress counts cancelled separately", "1 מתוך 2 הושלמו" in hdr and "1 בוטלו" in hdr, hdr)
    check("cancelled sub-task stays visible, marked 'בוטל'", page.locator("li.sub.st-cancelled").count() == 1 and page.locator("li.sub.st-cancelled .mini.cancelled").count() == 1)
    check("reason is kept", page.get_by_label("הערה או סיבה").first.input_value() == "הספק ביטל את ההזמנה")
    page.get_by_label("קטגוריה של תת-משימה").first.select_option(label="הנדסה ימית")
    check("sub-task can have a category", page.locator("li.sub .mini", has_text="הנדסה ימית").count() == 1)
    page.screenshot(path="/tmp/shots/15-detail.png", full_page=True)
    page.get_by_role("button", name="הושלם", exact=True).click()
    check("confirm for not-yet-done sub-tasks (cancelled ones don't count)", "נשארו 1 תתי-משימות" in page.get_by_role("dialog").inner_text())
    page.get_by_role("button", name="ביטול", exact=True).first.click()
    page.get_by_role("group", name="סטטוס").get_by_role("button", name="בוטל", exact=True).click()
    page.get_by_label("חזרה").click()
    check("cancelled task leaves open list", page.locator("li.card").filter(has_text=SECRET).count() == 0)
    nav(page, 2); page.get_by_role("button", name=re.compile("^בוטלו")).click()
    check("cancelled task kept in 'בוטלו' with its history", page.locator("li.card").filter(has_text=SECRET).count() == 1)
    page.locator("li.card").filter(has_text=SECRET).locator("button.open").click()
    check("sub-task states survive on a cancelled task", page.locator("li.sub").count() == 3 and page.locator("li.sub.st-cancelled").count() == 1)
    page.get_by_role("group", name="סטטוס").get_by_role("button", name="לביצוע", exact=True).click()
    page.get_by_label("חזרה").click()

    # ---------- categories ----------
    nav(page, 1)
    check("categories screen lists the category with counts", "הנדסה ימית" in page.locator(".catrow").first.inner_text() and "פתוחות" in page.locator(".catrow").first.inner_text())
    page.screenshot(path="/tmp/shots/16-cats.png")
    page.get_by_role("button", name="קטגוריה חדשה").click()
    page.get_by_label("שם הקטגוריה (למשל: פרויקט, יחידה)").fill('אמל"ח'); page.get_by_role("button", name="הוסף", exact=True).click()
    check("can add a category (opens it)", page.locator("h1").first.inner_text() == 'אמל"ח')
    page.get_by_role("button", name="משימה חדשה").click()
    check("new task from a category is pre-filed there", page.get_by_role("group", name="קטגוריה").get_by_role("button", name='אמל"ח', exact=True).get_attribute("aria-pressed") == "true")
    page.fill("#newTitle", "בדיקת מחסן"); page.get_by_role("button", name="הוסף משימה").click()
    check("task appears inside its category", page.locator("li.card").filter(has_text="בדיקת מחסן").count() == 1)
    page.get_by_label("חזרה לקטגוריות").click()
    nav(page, 0); show_all(page)
    page.get_by_role("button", name='אמל"ח', exact=True).click()
    check("home filter by category", page.locator("li.card").count() == 1)
    page.get_by_role("button", name="הכול", exact=True).click()

    # ---------- search covers completed + sub-tasks ----------
    nav(page, 3); page.fill("#searchInput", "הספק")
    check("search finds sub-task reason", page.locator("li.card").count() == 1)

    # ---------- lock, wrong codes, disk is ciphertext ----------
    page.get_by_label("נעל עכשיו").click()
    check("locked: secret not in page", SECRET not in page.content())
    check("forgot-code link on lock screen", "שכחתי את הקוד" in page.content())
    raw = page.evaluate("""async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('safetasks'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
      const out = await new Promise((res) => { const t = db.transaction('kv'); const q = t.objectStore('kv').getAll(); q.onsuccess=()=>res(q.result); });
      return JSON.stringify(out) + '||' + JSON.stringify(Object.entries(localStorage)) + '||' + document.cookie;
    }""")
    check("disk: no plaintext (tasks, categories, sub-task notes)", not any(x in raw for x in ["סוד", "הנדסה", "הספק", "תיקון", 'אמל']))
    for i in range(3):
        digits(page, "1111"); page.wait_for_timeout(2500)
    check("delay after wrong codes", "יותר מדי" in page.locator(".err").inner_text(), page.locator(".err").inner_text())
    check("number pad locked during delay", page.locator(".keys button").first.is_disabled())
    page.screenshot(path="/tmp/shots/17-lock-delay.png")
    page.evaluate("localStorage.removeItem('st.guard')"); page.reload()
    digits(page, "2580")
    page.wait_for_selector(".tiles", timeout=20000)
    show_all(page)
    check("correct code restores everything", page.locator("li.card").count() >= 4 and "הנדסה ימית" in page.content())

    # background => lock
    page.evaluate("""() => { Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}); document.dispatchEvent(new Event('visibilitychange')); }""")
    check("background locks and covers", page.locator(".keys").count() == 1 and page.locator("#cover").is_visible() and SECRET not in page.content())
    page.evaluate("""() => { Object.defineProperty(document,'hidden',{configurable:true,get:()=>false}); document.dispatchEvent(new Event('visibilitychange')); }""")
    digits(page, "2580"); page.wait_for_selector(".tiles", timeout=20000)

    # ---------- red-team regressions ----------
    page.get_by_role("button", name="משימה חדשה").click(); page.fill("#newTitle", "טיוטה שלא נשלחה")
    page.evaluate("() => { Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}); document.dispatchEvent(new Event('visibilitychange')); }")
    page.evaluate("() => { Object.defineProperty(document,'hidden',{configurable:true,get:()=>false}); document.dispatchEvent(new Event('visibilitychange')); }")
    digits(page, "2580"); page.wait_for_selector("#newTitle", timeout=20000)
    check("unsent draft survives a quick lock/unlock", page.input_value("#newTitle") == "טיוטה שלא נשלחה")
    page.get_by_role("button", name="ביטול", exact=True).click(); page.wait_for_selector(".nav")
    show_all(page)
    page.get_by_role("button", name="סמן כהושלם: פגישה עתידית").click(); page.wait_for_selector("#toast >> text=הושלמה ועברה")
    page.locator("button.open").filter(has_text="הכנת דוח").click()
    page.fill("input[aria-label='כותרת']", "הכנת דוח 2"); page.keyboard.press("Tab"); page.get_by_label("חזרה").click()
    page.locator("#toast .tbtn").click()
    show_all(page)
    check("stale toast undo does not undo a different action", page.locator("li.card").filter(has_text="הכנת דוח 2").count() == 1 and page.locator("li.card").filter(has_text="פגישה עתידית").count() == 0)
    page.locator("#undoBtn").click(); page.locator("#undoBtn").click()

    # ---------- change passcode to 8 digits (number pad flow) ----------
    nav(page, 4)
    page.get_by_role("button", name="החלפת קוד גישה").click()
    digits(page, "0000"); page.wait_for_timeout(1500)
    check("change code: wrong current code refused", "שגוי" in page.locator(".err").inner_text())
    digits(page, "2580"); page.wait_for_selector("text=בחר קוד חדש", timeout=15000)
    digits(page, "13572468"); page.get_by_role("button", name="המשך", exact=True).click()
    digits(page, "13572468"); page.wait_for_selector("text=החלפת קוד גישה >> nth=0", timeout=20000); page.wait_for_selector(".nav", timeout=20000)
    page.get_by_label("נעל עכשיו").click()
    digits(page, "25800000"); page.wait_for_timeout(2500)
    check("old code no longer works", page.locator(".keys").count() == 1)
    digits(page, "13572468"); page.wait_for_selector(".tiles", timeout=20000)
    show_all(page)
    check("new 8-digit code works, data intact", page.locator("li.card").count() >= 4)

    # ---------- export / import ----------
    nav(page, 4)
    page.get_by_role("button", name="ייצוא לקובץ מוצפן").click()
    check("export warns first", "יצא מהמכשיר" in page.get_by_role("dialog").inner_text())
    page.get_by_role("button", name="המשך").click()
    page.get_by_label("סיסמה", exact=True).fill("export-pass-1234"); page.get_by_label("אימות סיסמה").fill("export-pass-1234")
    with page.expect_download() as dl:
        page.get_by_role("button", name="צור קובץ").click()
    path = dl.value.path(); content = open(path, encoding="utf8").read()
    check("export file is encrypted", SECRET not in content and "הנדסה" not in content and '"app":"SafeTasksExport"' in content)
    nav(page, 0); add_task(page, "תוספת אחרי הגיבוי")
    nav(page, 4)
    with page.expect_file_chooser() as fc:
        page.get_by_role("button", name="ייבוא מקובץ גיבוי").click()
    fc.value.set_files(path)
    page.get_by_label("סיסמה", exact=True).fill("export-pass-1234"); page.get_by_role("button", name="פתח", exact=True).click()
    page.get_by_role("button", name="החלף", exact=True).click()
    nav(page, 0)
    show_all(page)
    check("import restored tasks AND categories", page.get_by_text("תוספת אחרי הגיבוי").count() == 0 and page.locator("li.card").count() >= 4)
    nav(page, 1)
    check("categories came back with the import", "הנדסה ימית" in page.content())

    # ---------- dark mode screenshot, wipe ----------
    nav(page, 4); page.select_option("select[aria-label='מראה']", "dark"); nav(page, 0)
    page.screenshot(path="/tmp/shots/18-home-dark.png", full_page=True)
    nav(page, 4); page.select_option("select[aria-label='מראה']", "light")
    page.get_by_role("button", name=re.compile("מחק הכול")).click(); page.get_by_role("button", name="המשך").click()
    page.get_by_label("הקלד מחק").fill("מחק"); page.get_by_role("button", name="מחק לצמיתות").click()
    page.wait_for_selector(".keys", timeout=15000)
    left = page.evaluate("""async () => {
      const names = (await indexedDB.databases()).map(x => x.name);
      if (!names.includes('safetasks')) return 0;
      const db = await new Promise((res, rej) => { const r = indexedDB.open('safetasks'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
      if (!db.objectStoreNames.contains('kv')) return 0;
      return await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').count(); q.onsuccess=()=>res(q.result); });
    }""")
    check("wipe: nothing left, setup shown again", left == 0 and "בחר קוד גישה" in page.content(), str(left))

    ext = [u for u in reqs if not u.startswith("http://127.0.0.1:8765/")]
    check("ZERO requests outside the app's own files", not ext, str(ext))
    check("no console/page errors", not errs, str(errs[:5]))
    b.close()

bad = [n for n, ok in results if not ok]
print(f"\n{len(results)-len(bad)}/{len(results)} passed")
sys.exit(1 if bad else 0)
