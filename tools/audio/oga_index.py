#!/usr/bin/env python3
"""Index OpenGameArt CC0 sound entries for a list of keywords -> JSON (title, author, licences, files)."""
import json, re, sys, time, urllib.parse, urllib.request, concurrent.futures as cf

UA = {"User-Agent": "Mozilla/5.0"}
BASE = "https://opengameart.org"

def get(url):
    for i in range(3):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode("utf8", "replace")
        except Exception as e:
            time.sleep(2)
    return ""

def search(kw):
    q = urllib.parse.urlencode({"keys": kw, "field_art_type_tid[]": 13, "field_art_licenses_tid[]": 4,
                                "sort_by": "count", "sort_order": "DESC"})
    html = get(f"{BASE}/art-search-advanced?{q}")
    return sorted(set(re.findall(r'<div class="field-item even"><a href="(/content/[^"]+)"', html)) |
                  set(re.findall(r'class="art-preview-title"><a href="(/content/[^"]+)"', html)))

def page(path):
    html = get(BASE + path)
    t = re.search(r'<title>(.*?) \| OpenGameArt', html)
    a = re.search(r'field-name-author-submitter.*?href="/users/([^"]+)"', html, re.S)
    lic = re.findall(r"<div class='license-name'>([^<]+)</div>", html)
    files = sorted(set(re.findall(r'href="(https://opengameart.org/sites/default/files/[^"]+\.(?:ogg|wav|mp3|zip|flac|7z|rar))"', html, re.I)))
    att = re.search(r'field-name-field-copyright-notice.*?<div class="field-item even">(.*?)</div>', html, re.S)
    return {"url": BASE + path, "title": t.group(1) if t else path, "author": a.group(1) if a else "",
            "licenses": lic, "files": files, "attribution": re.sub("<[^>]+>", "", att.group(1)).strip() if att else ""}

if __name__ == "__main__":
    kws = sys.argv[2:]
    paths = {}
    with cf.ThreadPoolExecutor(6) as ex:
        for kw, res in zip(kws, ex.map(search, kws)):
            for p in res: paths.setdefault(p, []).append(kw)
    with cf.ThreadPoolExecutor(8) as ex:
        pages = list(ex.map(page, list(paths)))
    for p in pages: p["keywords"] = paths[p["url"][len(BASE):]]
    json.dump(pages, open(sys.argv[1], "w"), indent=1)
    print(len(pages), "pages")
