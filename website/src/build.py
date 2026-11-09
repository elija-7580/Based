import json,re,os,sys
shared=open('shared.css').read()+'\n'+open('home.css').read()+'\n'+open('agents.css').read()
nav=open('nav.html').read(); foot=open('footer.html').read()
font='<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@600;700;800;900&amp;display=swap">'
pages=[
 ('Main','home','Based · Databases, docs and agents. Instant, private, everywhere.','Easy like Notion, private like Obsidian. The workspace for people who love how Notion works, not how it is run. Your data on your devices, huge databases that stay instant, EU servers, opt-in agents. Join the beta.','HOME',10400,{"typingSpeed":{"editor":"range","min":8,"max":60,"step":2,"unit":"ms","default":20}}),
 ('Workspace','workspace','Based Workspace · Big databases, zero waiting','Databases with every view, relations, rollups and pages in every row. Local speed, offline by default, three copies of your data, EU servers.','WORKSPACE',7600,{}),
 ('Agents','agents','Based Agents · Mission control for everything you work on','Opt-in agents that plan, delegate and come back to you. Morning briefings as a database, terminal to cloud to phone, MCP, your own keys. Every edit signed.','AGENTS',8200,{}),
 ('Switch','switch','Leaving Notion? · Keep the good part','An honest list of what Notion users complain about, with sources: data in the US, no end-to-end encryption, backups that cannot restore. Move to Based in ten minutes.','SWITCH',7000,{}),
 ('Roadmap','roadmap','Based Roadmap · Build it with us','The public Based roadmap: what shipped, what we build now and next. Vote for features or suggest your own.','ROADMAP',3600,{}),
 ('Manifesto','manifesto','Based Manifesto · Rebuilding knowledge work','You own your data, safety is not a pricing tier, agents sign their work, your AI your keys, built in Europe and in the open. Roadmap and build stats.','MANIFESTO',5400,{}),
]
bad=False
for name,key,title,desc,on,hgt,extra in pages:
    n=nav
    for k in ['HOME','WORKSPACE','AGENTS','SWITCH','ROADMAP','MANIFESTO']: n=n.replace('__ON_%s__'%k,'on' if k==on else '')
    body=open(key+'.body.html').read(); js=open(key+'.js').read()
    props={"theme":{"editor":"enum","options":["light","dark"],"default":"light"}}; props.update(extra); props["$preview"]={"width":1440,"height":hgt}
    pj=json.dumps(props,ensure_ascii=False).replace("'","&#39;")
    html=f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
{font}
<style>
{shared}
</style>
</helmet>
<div class="bsd" data-theme="{{{{theme}}}}" style="min-height: 100vh; display: flex; flex-direction: column;">
{n}
{body}
{foot}
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{pj}'>
{js}
</script>
</body>
</html>
'''
    open(f'../project/{name}.dc.html','w').write(html)
    if re.search(r'[—–]',html): print('DASH',name); bad=True
    open('/tmp/c.js','w').write("class DCLogic{constructor(p){this.props=p||{};this.state={}}setState(o){Object.assign(this.state,o)}}\n"+js+"\nconst c=new Component({});const v=c.renderVals();const holes="+json.dumps(sorted(set(re.findall(r'\{\{\s*([a-zA-Z_$][\w$]*)',body+n+foot))-set(re.findall(r'as="(\w+)"',body))-{'true','false'}))+";const miss=holes.filter(h=>!(h in v));console.log('"+name+"', Object.keys(v).length, 'missing:', miss.join(','));")
    print(os.popen('node /tmp/c.js 2>&1').read().strip())
from html.parser import HTMLParser
void={'meta','link','img','input','br','hr','path','circle','rect','stop'}
for name,*_ in pages:
    s=open(f'../project/{name}.dc.html').read().split('<x-dc>')[1].split('</x-dc>')[0]
    class P(HTMLParser):
        def __init__(s): super().__init__(); s.st=[]; s.err=[]
        def handle_starttag(s,t,a):
            if t not in void: s.st.append(t)
        def handle_endtag(s,t):
            if t in void: return
            if not s.st or s.st[-1]!=t: s.err.append((t,s.getpos()))
            for i in range(len(s.st)-1,-1,-1):
                if s.st[i]==t: del s.st[i:]; break
    p=P(); p.feed(s)
    if p.err or p.st: print('HTML',name,p.err[:3],p.st[:3])
