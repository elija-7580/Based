"""Build the static site for GitHub Pages from ../project/*.dc.html into ../dist."""
import os, re, shutil
SRC = os.path.join(os.path.dirname(__file__), '..', 'canvas')
OUT = os.path.join(os.path.dirname(__file__), '..', 'dist')
PAGES = {'Main': 'index.html', 'Workspace': 'workspace.html', 'Agents': 'agents.html', 'Switch': 'leaving-notion.html', 'Roadmap': 'roadmap.html', 'Manifesto': 'manifesto.html'}
BLOBS = {'/_blob/c3ccc021887376abcf7fe08d0002d913': 'assets/mark.svg', '/_blob/60426240b69c9dab9372c2741257d898': 'assets/mark-dark.svg'}
shutil.rmtree(OUT, ignore_errors=True); os.makedirs(OUT + '/assets')
for f in ['dc-lite.js', 'mark.svg', 'mark-dark.svg']:
    shutil.copy(f, OUT + '/assets/' + f)
shutil.copy('mark.svg', OUT + '/favicon.svg')
for name, out in PAGES.items():
    s = open(f'{SRC}/{name}.dc.html', encoding='utf-8').read()
    s = s.replace('<script src="./support.js"></script>', '<link rel="icon" href="favicon.svg" type="image/svg+xml">\n<script src="assets/dc-lite.js"></script>')
    for k, v in BLOBS.items(): s = s.replace(k, v)
    s = s.replace(' src="{{', ' data-dc-src="{{')  # avoid the browser fetching raw template URLs
    for n, o in PAGES.items(): s = s.replace(f'{n}.dc.html', o)
    assert '/_blob/' not in s and '.dc.html' not in s, name
    open(f'{OUT}/{out}', 'w', encoding='utf-8').write(s)
open(OUT + '/.nojekyll', 'w').close()
open(OUT + '/README.md', 'w').write('# Based website\n\nStatic build of the Based marketing site. Generated, do not edit by hand.\n')
print('exported', len(PAGES), 'pages to', os.path.abspath(OUT))
