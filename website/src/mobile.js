class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.state = { name: '', email: '', role: 'knowledge', phase: 'form', replyChars: 0, reply: '', reply2: 0, clock: 0, flapI: 0, promptI: 0, promptN: 0, sheet: -1, pain: 0, when: 'beta' };
    this.timers = { reply: [], loop: [] };
    this.prompts = ['Prepare my week: deadlines first, then the Acme proposal', 'Summarise yesterday\u2019s calls into the Clients database', 'Find sources for thesis chapter 2 and add them to Reading', 'Draft the investor update from the Metrics database'];
    this.flapWords = ['second brain', 'business', 'research', 'clients and deals', 'thesis', 'projects', 'team wiki', 'log files', 'reading list'];
  }
  componentDidMount() {
    this.tick = setInterval(() => this.setState({ clock: (this.state.clock + 1) % 60, flapI: this.state.flapI + 1 }), 2600);
    this.typeTimer = setInterval(() => {
      const p = this.prompts[this.state.promptI % this.prompts.length];
      if (this.state.promptN < p.length) this.setState({ promptN: this.state.promptN + 1 });
      else if (!this.hold) { this.hold = setTimeout(() => { this.hold = null; this.setState({ promptI: this.state.promptI + 1, promptN: 0 }); }, 2400); }
    }, 55);
  }
  componentWillUnmount() { clearInterval(this.tick); clearInterval(this.typeTimer); clearTimeout(this.hold); this.clearTimers(); }
  clearTimers(g) { (g ? [g] : ['reply', 'loop']).forEach((k) => { this.timers[k].forEach((t) => clearTimeout(t)); this.timers[k] = []; }); }
  later(fn, ms, g) { const k = g || 'loop'; const t = setTimeout(fn, ms); this.timers[k].push(t); return t; }
  reduced() { return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  typeReply(total) {
    if (this.reduced()) { this.setState({ replyChars: total, phase: 'done' }); return; }
    const sp = this.props.typingSpeed ?? 20;
    const step = () => {
      const n = this.state.replyChars;
      if (n >= total) { this.setState({ phase: 'done' }); return; }
      const ch = this.state.reply[n] || '';
      this.setState({ replyChars: n + 1 });
      this.later(step, /[.,:\n]/.test(ch) ? sp * 6 : sp + Math.random() * sp, 'reply');
    };
    step();
  }  firstName() {
    const n = (this.state.name || '').trim();
    if (n) return n.split(/\s+/)[0];
    const local = (this.state.email.split('@')[0] || '').split(/[._+\-0-9]/)[0];
    if (local.length < 2) return '';
    return local.charAt(0).toUpperCase() + local.slice(1).toLowerCase();
  }  org() {
    const domain = (this.state.email.split('@')[1] || '').toLowerCase();
    if (!domain || /^(gmail|googlemail|icloud|me|mac|outlook|hotmail|live|yahoo|gmx|web|proton|protonmail|aol)\./.test(domain)) return '';
    const parts = domain.split('.').filter((p) => !['edu', 'ac', 'at', 'de', 'ch', 'uk', 'com', 'org', 'net', 'io', 'co', 'student', 'students', 'mail', 'eu'].includes(p));
    const label = parts[parts.length - 1] || '';
    if (!label) return '';
    return label.length <= 4 ? label.toUpperCase() : label.charAt(0).toUpperCase() + label.slice(1);
  }  composeReply() {
    const name = this.firstName();
    const hi = name ? 'Hi ' + name + ', ' : 'Hi, ';
    const org = this.org();
    const r = this.state.role;
    const tail = "\n\nHomework for today: export your Notion as HTML. I'll bring it over on day one, databases included, without the 32-character file names.";
    if (r === 'business') {
      return hi + "you're in" + (org ? ', and nice to meet the team at ' + org : '') + ".\n\nWhen the beta opens, point me at your clients and projects database. I'll keep it current, prepare a briefing every morning and tell you when something needs a decision. Your data stays on your devices, and every line I write is marked." + tail;
    }
    if (r === 'study') {
      return hi + "you're in" + (org ? ', and nice to meet someone from ' + org : '') + ".\n\nWhen the beta opens, bring me your next lecture. I'll write the notes while you listen, pull out the formulas and file everything into your course database." + tail;
    }
    if (r === 'dev') {
      return hi + "you're in.\n\nWhen the beta opens, talk to me from your terminal, let me keep working in the cloud sandbox and check in from your phone. Same session, same workspace, reachable over MCP from whatever AI you already use." + tail;
    }
    return hi + "you're in" + (org ? ', and hello to everyone at ' + org : '') + ".\n\nWhen the beta opens, I'll help you turn scattered notes into a second brain that stays fast at any size. I'm off by default, I write in the margin and I sign everything." + tail;
  }  join(e) {
    e.preventDefault();
    if (!this.state.email || this.state.email.indexOf('@') < 1) return;
    this.clearTimers('reply');
    const reply = this.composeReply();
    this.setState({ phase: 'thinking', reply, replyChars: 0 });
    this.later(() => { this.setState({ phase: 'writing' }); this.typeReply(reply.length); }, this.reduced() ? 0 : 1200, 'reply');
  }  renderVals() {
    const theme = this.props.theme ?? 'light';
    const s = this.state;
    const ph = s.phase;
    const now = new Date();
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const painsRaw = [
      { title: 'Your data, in Oregon', joke: 'By default your Notion workspace lives in the United States. EU storage? That\u2019s an Enterprise conversation with a sales team.', fixTitle: 'Your devices, EU servers', fix: 'Your workspace lives on your devices. Based Cloud runs in the EU and will be end-to-end encrypted, so not even we can read it.', src: 'Notion help center: data residency.' },
      { title: 'The grey skeleton', joke: 'You know its shape by heart. It has been your most reliable coworker for years.', fixTitle: 'Opens like a file', fix: 'Local first, so pages open before you let go of the click. Online, offline, in a tunnel.', src: 'Notion help center: large databases slow pages down.' },
      { title: '“Available offline”*', joke: '*Pick your pages in advance. Databases: first 50 rows. Formulas and rollups: see you back online.', fixTitle: 'Offline is just on', fix: 'Every page, every row, every formula. There is no offline mode because nothing needs to be online.', src: 'Notion offline mode documentation and guides.' },
      { title: 'The backup that isn\u2019t', joke: 'Notion\u2019s export can\u2019t recreate your workspace. So you pay a second company to back up the first.', fixTitle: 'You own it. It stays.', fix: 'Your data sits on your own devices. Every version is kept and snapshots go to a drive you choose. Nothing gets deleted behind your back.', src: 'Notion help center on exports; Reddit, 2026.' },
      { title: 'In a meeting? Notion noticed.', joke: 'Join a call and the desktop app offers to take AI meeting notes. Helpful. Slightly unsettling.', fixTitle: 'Transcribed on your Mac', fix: 'Meeting notes when you start them, transcribed on your device, offline. The audio never leaves your Mac.', src: 'Hacker News thread on Notion Desktop.' },
      { title: 'Ask AI → “Upgrade”', joke: 'Full Notion AI lives on Business at $20 a seat. Custom agents run on credits. Your OpenAI plan? Irrelevant, apparently.', fixTitle: 'Bring the AI you pay for', fix: 'Connect ChatGPT, Claude, an API key or a local model. No second AI subscription, no credits.', src: 'Notion pricing, November 2026.' }
    ];
    const menus = [
      { k: 'Agent', v: 'Main', icon: '\u25cf', title: 'Agent', hint: 'who takes this', foot: 'The main agent can hand work to the others.', options: [
        { n: 'Main', d: 'Plans, delegates, writes updates', icon: 'M', on: true }, { n: 'Tutor', d: 'Explains and quizzes you', icon: 'T' }, { n: 'Researcher', d: 'Reads sources, cites them', icon: 'R' }, { n: 'Night shift', d: 'Works through your backlog at night', icon: 'N' } ] },
      { k: 'Model', v: 'Auto', icon: '\u25c6', title: 'Compute', hint: 'how hard Based thinks', foot: 'Use your ChatGPT or Claude account, an API key or a local model.', options: [
        { n: 'Auto', d: 'Picks per task, recommended', icon: 'A', on: true }, { n: 'Fast', d: 'Quick answers, light tasks', icon: 'F' }, { n: 'Deep', d: 'Long reasoning, big documents', icon: 'D' }, { n: 'Specific model', d: 'Claude, GPT, Gemini or local', icon: '\u2026' } ] },
      { k: 'Permission', v: 'Ask before edits', icon: '\u25b2', title: 'Permission', hint: 'what Based may do alone', foot: 'Agents never delete or share anything without asking.', options: [
        { n: 'Ask every time', d: 'Every step needs your OK', icon: '1' }, { n: 'Ask before edits', d: 'Research freely, ask before changing pages', icon: '2', on: true }, { n: 'Work freely', d: 'Within budget and scope, all edits marked', icon: '3' } ] },
      { k: 'Tools', v: '4 on', icon: '\u25a0', title: 'Tools and connectors', hint: 'what Based can reach', foot: 'Any MCP server works. Add your own in settings.', options: [
        { n: 'Your workspace', d: 'Pages, databases, files', icon: 'W', on: true }, { n: 'Web search', d: 'With sources', icon: 'S', on: true }, { n: 'Calendar and mail', d: 'Through MCP', icon: 'C', on: true }, { n: 'Code sandbox', d: 'Runs scripts in the cloud, opt-in', icon: '>', on: true } ] },
      { k: 'Privacy', v: 'Check on', icon: '\u2726', title: 'Before sending', hint: 'runs on your device', foot: 'Planned: a local check flags private details before a prompt leaves your Mac.', options: [
        { n: 'Privacy check', d: 'Finds names, numbers, health and money details', icon: 'P', on: true }, { n: 'Memory', d: 'Remember what matters across chats', icon: 'M', on: true }, { n: 'Skills', d: '3 active: client updates, lecture notes, weekly review', icon: 'K', on: true } ] }
    ];
    const hNow = 12.4 + (s.clock / 59) * 4.2;
    const hm = (h) => String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.floor((h % 1) * 60)).padStart(2, '0');
    const ST = {
      sched: { status: 'Scheduled', dot: '#7C9BD6', chipBg: 'var(--status-ready)', chipFg: 'var(--ink)' },
      work: { status: 'Working', dot: 'var(--marker-strong)', chipBg: 'var(--marker)', chipFg: 'var(--ink)' },
      done: { status: 'Done', dot: 'var(--synced)', chipBg: '#DCEFE3', chipFg: '#2F6B47' },
      need: { status: 'Needs you', dot: '#D9739A', chipBg: 'var(--status-review)', chipFg: '#8A2F52' }
    };
    const lanes = [
      { t: 'Morning briefing', who: 'Main agent', a: 7.5, b: 8.25 },
      { t: 'Thesis sources', who: 'Researcher, local model', a: 8, b: 11.5 },
      { t: 'Acme proposal draft', who: 'Writer, Claude', a: 9.5, b: 13, ask: true },
      { t: 'Q4 metrics', who: 'Coder, GPT', a: 12, b: 15.5 },
      { t: 'Northwind call notes', who: 'Transcribed on your Mac', a: 14, b: 15 },
      { t: 'Night shift', who: 'Backlog, tests, build log', a: 23, b: 24 }
    ].map((l) => {
      const k = hNow < l.a ? 'sched' : hNow < l.b ? 'work' : l.ask ? 'need' : 'done';
      const st = ST[k];
      const f = k === 'work' ? Math.round(((hNow - l.a) / (l.b - l.a)) * 100) : k === 'sched' ? 0 : 100;
      return { t: l.t, who: l.who, when: hm(l.a), dot: st.dot, status: k === 'work' ? f + ' %' : st.status, chipBg: st.chipBg, chipFg: st.chipFg, fill: f + '%', barBg: st.dot };
    });
    const open = s.sheet;
    const sheetMenu = open >= 0 ? menus[open] : null;
    return {
      theme,
      markSrc: '/_blob/c3ccc021887376abcf7fe08d0002d913',
      markDarkSrc: '/_blob/60426240b69c9dab9372c2741257d898',
      flapWord: this.flapWords[s.flapI % this.flapWords.length],
      flipCls: s.flapI % 2 === 0 ? 'fa' : 'fb',
      nowTxt: hm(hNow),
      lanes,
      legend: [['Done', 'var(--synced)'], ['Working', 'var(--marker-strong)'], ['Needs you', '#D9739A'], ['Scheduled', '#7C9BD6']].map(([t, dot]) => ({ t, dot })),
      promptShown: this.prompts[s.promptI % this.prompts.length].slice(0, s.promptN),
      pills: menus.map((m, i) => ({ k: m.k, v: m.v, icon: m.icon, open: () => this.setState({ sheet: i }), pressed: open === i ? 'true' : 'false' })),
      sheetOpen: !!sheetMenu,
      sheet: sheetMenu ? { title: sheetMenu.title, hint: sheetMenu.hint, foot: sheetMenu.foot, options: sheetMenu.options.map((o) => ({ n: o.n, d: o.d, icon: o.icon, check: o.on ? '\u2713' : '', bg: o.on ? 'var(--surface-raised)' : 'transparent', tileBg: o.on ? 'var(--button)' : 'var(--surface-raised)', tileFg: o.on ? 'var(--button-ink)' : 'var(--ink)' })) } : { title: '', hint: '', foot: '', options: [] },
      closeSheet: () => this.setState({ sheet: -1 }),
      pains: painsRaw.map((p, i) => ({ n: String(i + 1).padStart(2, '0'), title: p.title, joke: p.joke, fixTitle: p.fixTitle, fix: p.fix })),
      whenTabs: [['beta', 'Beta on the Mac'], ['release', 'Release']].map(([id, t]) => ({ t, sel: s.when === id ? 'true' : 'false', bg: s.when === id ? 'var(--bg)' : 'transparent', sh: s.when === id ? 'var(--shadow-panel)' : 'none', pick: () => this.setState({ when: id }) })),
      whenTitle: s.when === 'beta' ? 'The fast local workspace.' : 'Everywhere, encrypted.',
      whenItems: s.when === 'beta'
        ? ['Mac app, data stored locally', 'Sync between your Apple devices through iCloud', 'Databases, pages, import from Notion', 'Agents with your own keys, opt-in', 'Meeting notes transcribed on your Mac, offline']
        : ['Based Cloud on EU servers, end-to-end encrypted', 'iPhone, iPad, web, then Windows, Linux and Android', 'One agent session across terminal, cloud and phone', 'MCP for every AI you use', 'Self-hosting for anyone who wants it'],
      name: s.name, email: s.email,
      setName: (e) => this.setState({ name: e.target.value }),
      setEmail: (e) => this.setState({ email: e.target.value }),
      roles: [['knowledge', 'my second brain'], ['business', 'my business'], ['study', 'studying'], ['dev', 'building things']].map(([id, label]) => ({
        label, pressed: s.role === id ? 'true' : 'false',
        bg: s.role === id ? 'var(--marker)' : 'rgba(255,255,255,.12)', fg: s.role === id ? '#1F1F1D' : '#F2F2EF',
        pick: () => this.setState({ role: id })
      })),
      join: (e) => this.join(e),
      reset: () => { this.clearTimers('reply'); this.setState({ phase: 'form', replyChars: 0 }); },
      showForm: ph === 'form', showReply: ph !== 'form', thinking: ph === 'thinking', typing: ph === 'writing', replyDone: ph === 'done',
      replyShown: s.reply.slice(0, s.replyChars),
      replyMeta: ph === 'thinking' ? 'is writing\u2026' : 'to you, ' + hhmm
    };
  }
}
