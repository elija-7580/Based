class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.state = { name: '', email: '', role: 'knowledge', phase: 'form', replyChars: 0, reply: '', flipped: {}, statsT: 0, flapI: 0, ev: 0, menuI: 0, promptI: 0, promptN: 0, clock: 0 };
    this.timers = { reply: [], loop: [] };
    this.prompts = ['Prepare my week: deadlines first, then the Acme proposal', 'Summarise yesterday\u2019s calls into the Clients database', 'Find sources for thesis chapter 2 and add them to Reading', 'Draft the investor update from the Metrics database'];
    this.flapWords = ['second brain', 'business', 'research', 'clients and deals', 'thesis', 'projects', 'team wiki', 'log files', 'reading list'];
  }
  static split(text, start, step) {
    let i = 0;
    return text.split(' ').map((w, wi, arr) => ({ sp: wi < arr.length - 1 ? ' ' : '', chars: w.split('').map((c) => ({ c, d: (start + (i++) * step) + 'ms' })) }));
  }
  componentDidMount() {
    this.flapTimer = setInterval(() => this.setState({ flapI: this.state.flapI + 1 }), 2800);
    this.typeTimer = setInterval(() => {
      const p = this.prompts[this.state.promptI % this.prompts.length];
      if (this.state.promptN < p.length) this.setState({ promptN: this.state.promptN + 1 });
    }, 45);
    this.menuTimer = setInterval(() => this.setState({ menuI: this.state.menuI + 1, promptI: this.state.menuI % 2 === 1 ? this.state.promptI + 1 : this.state.promptI, promptN: this.state.menuI % 2 === 1 ? 0 : this.state.promptN }), 2600);
    this.evTimer = setInterval(() => this.setState({ ev: (this.state.ev + 1) % 8, clock: (this.state.clock + 1) % 60 }), 2200);
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver((entries) => {
        entries.forEach((e) => { if (e.isIntersecting && e.target === this.statsEl && this.state.statsT === 0) this.countUp(); });
      }, { threshold: 0.35 });
      if (this.statsEl) this.io.observe(this.statsEl);
    } else { this.setState({ statsT: 1 }); }
  }
  componentWillUnmount() { clearInterval(this.typeTimer); clearInterval(this.menuTimer); clearInterval(this.flapTimer); clearInterval(this.evTimer); this.clearTimers(); if (this.io) this.io.disconnect(); }
  clearTimers(g) { (g ? [g] : ['reply', 'loop']).forEach((k) => { this.timers[k].forEach((t) => clearTimeout(t)); this.timers[k] = []; }); }
  later(fn, ms, g) { const k = g || 'loop'; const t = setTimeout(fn, ms); this.timers[k].push(t); return t; }
  reduced() { return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  countUp() {
    if (this.reduced()) { this.setState({ statsT: 1 }); return; }
    const start = Date.now();
    const step = () => { const t = Math.min(1, (Date.now() - start) / 1400); this.setState({ statsT: Math.max(0.001, 1 - Math.pow(1 - t, 3)) }); if (t < 1) this.later(step, 30); };
    step();
  }
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
  }
  firstName() {
    const n = (this.state.name || '').trim();
    if (n) return n.split(/\s+/)[0];
    const local = (this.state.email.split('@')[0] || '').split(/[._+\-0-9]/)[0];
    if (local.length < 2) return '';
    return local.charAt(0).toUpperCase() + local.slice(1).toLowerCase();
  }
  org() {
    const domain = (this.state.email.split('@')[1] || '').toLowerCase();
    if (!domain || /^(gmail|googlemail|icloud|me|mac|outlook|hotmail|live|yahoo|gmx|web|proton|protonmail|aol)\./.test(domain)) return '';
    const parts = domain.split('.').filter((p) => !['edu', 'ac', 'at', 'de', 'ch', 'uk', 'com', 'org', 'net', 'io', 'co', 'student', 'students', 'mail', 'eu'].includes(p));
    const label = parts[parts.length - 1] || '';
    if (!label) return '';
    return label.length <= 4 ? label.toUpperCase() : label.charAt(0).toUpperCase() + label.slice(1);
  }
  composeReply() {
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
  }
  join(e) {
    e.preventDefault();
    if (!this.state.email || this.state.email.indexOf('@') < 1) return;
    this.clearTimers('reply');
    const reply = this.composeReply();
    this.setState({ phase: 'thinking', reply, replyChars: 0 });
    this.later(() => { this.setState({ phase: 'writing' }); this.typeReply(reply.length); }, this.reduced() ? 0 : 1200, 'reply');
  }
  renderVals() {
    const theme = this.props.theme ?? 'light';
    const dark = theme === 'dark';
    const s = this.state;
    const ph = s.phase;
    const now = new Date();
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const word = this.flapWords[s.flapI % this.flapWords.length];
    const ev = s.ev;
    const painsRaw = [
      { title: 'Your data, in Oregon', joke: 'By default your Notion workspace lives in the United States. EU storage? That\u2019s an Enterprise conversation with a sales team.', fixTitle: 'Your devices, EU servers', fix: 'Your workspace lives on your devices. Based Cloud runs in the EU and will be end-to-end encrypted, so not even we can read it.', src: 'Notion help center: data residency.' },
      { title: 'The grey skeleton', joke: 'You know its shape by heart. It has been your most reliable coworker for years.', fixTitle: 'Opens like a file', fix: 'Local first, so pages open before you let go of the click. Online, offline, in a tunnel.', src: 'Notion help center: large databases slow pages down.' },
      { title: '“Available offline”*', joke: '*Pick your pages in advance. Databases: first 50 rows. Formulas and rollups: see you back online.', fixTitle: 'Offline is just on', fix: 'Every page, every row, every formula. There is no offline mode because nothing needs to be online.', src: 'Notion offline mode documentation and guides.' },
      { title: 'The backup that isn\u2019t', joke: 'Notion\u2019s export can\u2019t recreate your workspace. So you pay a second company to back up the first.', fixTitle: 'You own it. It stays.', fix: 'Your data sits on your own devices. Every version is kept and snapshots go to a drive you choose. Nothing gets deleted behind your back.', src: 'Notion help center on exports; Reddit, 2026.' },
      { title: 'In a meeting? Notion noticed.', joke: 'Join a call and the desktop app offers to take AI meeting notes. Helpful. Slightly unsettling.', fixTitle: 'Transcribed on your Mac', fix: 'Meeting notes when you start them, transcribed on your device, offline. The audio never leaves your Mac.', src: 'Hacker News thread on Notion Desktop.' },
      { title: 'Ask AI → “Upgrade”', joke: 'Full Notion AI lives on Business at $20 a seat. Custom agents run on credits. Your OpenAI plan? Irrelevant, apparently.', fixTitle: 'Bring the AI you pay for', fix: 'Connect ChatGPT, Claude, an API key or a local model. No second AI subscription, no credits.', src: 'Notion pricing, November 2026.' }
    ];
    const ease = s.statsT;
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
    const mi = Math.floor(s.menuI / 2) % menus.length;
    const menuOpen = s.menuI % 2 === 0;
    const hNow = 12.4 + (s.clock / 59) * 4.2;
    const pct = (h) => ((h - 6) / 18) * 100;
    const hm = (h) => String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.floor((h % 1) * 60)).padStart(2, '0');
    const ST = {
      sched: { status: 'Scheduled', bg: '#C3D4F2', chipBg: 'var(--status-ready)', chipFg: 'var(--ink)' },
      work: { status: 'Working', bg: 'var(--marker)', chipBg: 'var(--marker)', chipFg: 'var(--ink)' },
      done: { status: 'Done', bg: '#A9D6B8', chipBg: '#DCEFE3', chipFg: '#2F6B47' },
      need: { status: 'Needs you', bg: 'var(--status-review)', chipBg: 'var(--status-review)', chipFg: '#8A2F52' }
    };
    return {
      theme,
      heroLabel: 'Databases, docs and agents. Instant. Private. Everywhere.',
      hero1: Component.split('Databases, docs and agents.', 0, 18),
      hero2: Component.split('Instant. Private. Everywhere.', 520, 18),
      flapWord: word,
      flipCls: s.flapI % 2 === 0 ? 'fa' : 'fb',
      markSrc: dark ? '/_blob/60426240b69c9dab9372c2741257d898' : '/_blob/c3ccc021887376abcf7fe08d0002d913',
      markDarkSrc: '/_blob/60426240b69c9dab9372c2741257d898',
      name: s.name, email: s.email,
      setName: (e) => this.setState({ name: e.target.value }),
      setEmail: (e) => this.setState({ email: e.target.value }),
      roles: [['knowledge', 'my second brain'], ['business', 'my business'], ['study', 'studying'], ['dev', 'building things']].map(([id, label]) => ({
        label, pressed: s.role === id ? 'true' : 'false',
        bg: s.role === id ? 'var(--button)' : 'var(--bg)', fg: s.role === id ? 'var(--button-ink)' : 'var(--ink)',
        pick: () => this.setState({ role: id })
      })),
      join: (e) => this.join(e),
      reset: () => { this.clearTimers('reply'); this.setState({ phase: 'form', replyChars: 0 }); },
      showForm: ph === 'form', showReply: ph !== 'form', thinking: ph === 'thinking',
      writing: ph === 'writing' || ph === 'done', typing: ph === 'writing', replyDone: ph === 'done',
      replyShown: s.reply.slice(0, s.replyChars),
      replyMeta: ph === 'thinking' ? 'is writing…' : 'to you, ' + hhmm,
      barOpacity: ph === 'done' ? 1 : 0.25,
      dbRows: [
        { t: 'Acme GmbH', s: 'Proposal', bg: 'var(--marker)', v: '€48k' },
        { t: 'Northwind', s: 'Active', bg: 'var(--status-ready)', v: '€120k' },
        { t: 'Kranz & Partner', s: 'Review', bg: 'var(--status-review)', v: '€22k' },
        { t: 'Lumen Labs', s: 'Active', bg: 'var(--status-ready)', v: '€76k' },
        { t: 'Polar Studio', s: 'Paused', bg: 'var(--status-blocked)', v: '€9k' }
      ],
      boardCols: [
        { t: 'Lead', items: ['Polar Studio', 'Vienna Ventures'] },
        { t: 'Proposal', items: ['Acme GmbH', 'Kranz'] },
        { t: 'Active', items: ['Northwind', 'Lumen Labs'] }
      ],
      pings: [
        { who: 'Main agent', time: '07:30', t: 'Your morning briefing is ready: 2 deadlines, 1 approval, 3 pages changed overnight.' },
        { who: 'Researcher', time: '11:02', t: 'Done. Competitor table added to Projects/Launch, 14 sources linked.' },
        { who: 'Main agent', time: '16:58', t: 'One thing needs you: approve the proposal draft for Acme.' }
      ],
      evNodes: [
        { t: 'Terminal', g: '>_', x: '8%', r: '18px', on: ev <= 1 || ev === 7 },
        { t: 'Cloud sandbox', g: '\u25cc', x: '36%', r: '50%', on: ev >= 2 && ev <= 3 },
        { t: 'Phone', g: '\u25a2', x: '64%', r: '26px', on: ev >= 4 && ev <= 5 },
        { t: 'Workspace', g: 'b', x: '92%', r: '22px', on: ev === 6 }
      ].map((n) => Object.assign(n, { bg: n.on ? 'var(--button)' : 'var(--bg)', fg: n.on ? 'var(--button-ink)' : 'var(--ink)', s: n.on ? '1.12' : '1' })),
      evDot: ['8%', '8%', '36%', '36%', '64%', '64%', '92%', '8%'][ev],
      evWhere: ['Terminal, 09:14', 'Terminal, 09:14', 'Cloud sandbox, 09:20', 'Cloud sandbox, 10:05', 'Phone, 10:06', 'Phone, 10:07', 'Workspace, 10:08', 'Terminal, 10:30'][ev],
      evMsg: [
        'based ask \u201csummarise the Acme call and update the deal\u201d',
        'Planning 2 tasks. You can close the lid.',
        'Moved to the cloud sandbox. Writing the summary.',
        'Summary done. Updating deal stage and next steps.',
        'Acme summary is ready. Move the deal to Proposal?',
        'You: Yes, and draft the proposal by Friday.',
        'Saved to Deals/Acme. 3 changes, all marked.',
        'Back at your desk: the session is still here, nothing to re-explain.'
      ][ev],
      nowTxt: hm(hNow),
      nowLeft: 'calc(25px + var(--tl-name) + (100% - 40px - var(--tl-name) - var(--tl-chipgap)) * ' + (pct(hNow) / 100).toFixed(4) + ')',
      menuOpen,
      legend: [['Done', '#DCEFE3', 'var(--synced)'], ['Working', 'var(--marker)', 'var(--marker-strong)'], ['Needs you', 'var(--status-review)', '#D9739A'], ['Scheduled', 'var(--status-ready)', '#7C9BD6']].map(([t, bg, dot]) => ({ t, bg, dot })),
      lanes: [
        { t: 'Morning briefing', who: 'Main agent, Fast', a: 7.5, b: 8.25 },
        { t: 'Thesis sources', who: 'Researcher, local model', a: 8, b: 11.5 },
        { t: 'Acme proposal draft', who: 'Writer, Claude', a: 9.5, b: 13, ask: true },
        { t: 'Q4 metrics', who: 'Coder, GPT', a: 12, b: 15.5 },
        { t: 'Northwind call notes', who: 'Transcribed on your Mac', a: 14, b: 15 },
        { t: 'Night shift', who: 'Backlog, tests, build log', a: 23, b: 24 }
      ].map((l) => {
        const k = hNow < l.a ? 'sched' : hNow < l.b ? 'work' : l.ask ? 'need' : 'done';
        const st = ST[k];
        const f = k === 'work' ? Math.round(((hNow - l.a) / (l.b - l.a)) * 100) : k === 'sched' ? 0 : 100;
        return { t: l.t, who: l.who, x: pct(l.a).toFixed(2) + '%', w: (pct(l.b) - pct(l.a)).toFixed(2) + '%', label: hm(l.a) + ' to ' + hm(l.b), bg: st.bg, fill: f + '%', fillBg: k === 'work' ? 'var(--marker-strong)' : 'transparent', status: k === 'work' ? f + ' %' : st.status, chipBg: st.chipBg, chipFg: st.chipFg };
      }),
      promptShown: this.prompts[s.promptI % this.prompts.length].slice(0, s.promptN),
      pills: menus.map((m, i) => ({ k: m.k, v: m.v, icon: m.icon, bg: (menuOpen && i === mi) ? 'var(--button)' : 'var(--surface-raised)', fg: (menuOpen && i === mi) ? 'var(--button-ink)' : 'var(--ink)', dotBg: (menuOpen && i === mi) ? 'rgba(255,255,255,.15)' : 'var(--bg)' })),
      menu: { title: menus[mi].title, hint: menus[mi].hint, foot: menus[mi].foot, options: menus[mi].options.map((o) => ({ n: o.n, d: o.d, icon: o.icon, check: o.on ? '\u2713' : '', bg: o.on ? 'var(--surface-raised)' : 'transparent', tileBg: o.on ? 'var(--button)' : 'var(--surface-raised)', tileFg: o.on ? 'var(--button-ink)' : 'var(--ink)' })) },
      apps: [
        { n: 'Notion', x: '24%', y: '74%', size: '34px', bg: 'var(--control-border)', sh: 'none', d: '200ms' },
        { n: 'Obsidian', x: '76%', y: '26%', size: '34px', bg: 'var(--control-border)', sh: 'none', d: '400ms' },
        { n: 'Based', x: '24%', y: '24%', size: '46px', bg: 'var(--marker-strong)', sh: '0 0 0 8px rgba(224,194,74,.25)', d: '700ms' }
      ],
      pains: painsRaw.map((p, i) => {
        const on = !!s.flipped[i];
        return Object.assign({}, p, {
          n: String(i + 1).padStart(2, '0'), cls: on ? 'on' : '', pressed: on ? 'true' : 'false',
          aria: on ? p.fixTitle + '. ' + p.fix : p.title + '. ' + p.joke + ' Show what Based does.',
          toggle: () => this.setState({ flipped: Object.assign({}, s.flipped, { [i]: !on }) })
        });
      }),
      statsRef: (el) => { this.statsEl = el; },
      stats: [
        { v: Math.round(221 * ease), l: 'Notion features tracked one by one, from the public help pages' },
        { v: Math.round(178 * ease), l: 'already working in the prototype. The rest is on the roadmap.' },
        { v: '0', l: 'servers your notes depend on. Local first, the cloud is optional.' },
        { v: '1 + ∞', l: 'one human in Vienna, plus a night shift of agents that ships while he sleeps' }
      ],
      uses: [
        { n: 'Second brain', t: 'Everything you know, linked.', d: 'Notes, reading, ideas and journals in databases that stay fast at any size, with a graph of how it all connects.' },
        { n: 'Business', t: 'Run the company on it.', d: 'Clients, deals, projects and logs as databases. Agents keep them current and brief you every morning.' },
        { n: 'Research and study', t: 'From lecture to paper.', d: 'Record, transcribe on device, cite sources. Course and literature databases that link themselves.' },
        { n: 'Builders', t: 'Wired into your tools.', d: 'CLI, MCP, your own keys and local models. Open source, so you can read every line that touches your data.' }
      ],
    };
  }
}
