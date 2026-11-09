"""Inject roadmap.json (export of the Notion view "Website-Roadmap") into roadmap.js.
Query: SELECT "userDefined:ID" id, Roadmap, "Roadmap-Titel" t, "Website-Bereich" a FROM <Based Backlog> WHERE Roadmap IS NOT NULL ORDER BY id"""
import json, re
rows = json.load(open('roadmap.json'))
order = {'Shipped': 0, 'Now': 1, 'Next': 2, 'Later': 3}
rows = sorted(rows, key=lambda r: (order[r['Roadmap']], r['id']))
js = open('roadmap.js').read()
js = re.sub(r'/\*ROADMAP\*/.*?/\*END\*/', '/*ROADMAP*/' + json.dumps(rows, ensure_ascii=False).replace('\\', '\\\\') + '/*END*/', js, flags=re.S)
open('roadmap.js', 'w').write(js)
print(len(rows), 'roadmap items')
