class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.state = { t: 0, factor: 1, view: 'table', q: '', status: 'all', peek: -1, logN: 6, cipherSeed: 1 };
    this.projects = [
      { t: 'Website relaunch', s: 'In progress', c: 'Northwind', due: 'Nov 21', start: 4, len: 30, roll: '7/12', agent: 1, links: ['Northwind, Clients', 'Kickoff call, Meetings', 'Brand guide, Docs'], body: 'New site on the shared design system. The main agent drafts copy from the brand guide; design reviews every Thursday.' },
      { t: 'Q4 investor update', s: 'Review', c: 'Internal', due: 'Nov 14', start: 0, len: 22, roll: '4/5', agent: 1, links: ['Board, People', 'Metrics Q3, Reports'], body: 'Numbers pulled from the metrics database, narrative by you. Waiting for the final revenue figure.' },
      { t: 'Acme onboarding', s: 'Ready', c: 'Acme GmbH', due: 'Dec 2', start: 30, len: 26, roll: '0/9', agent: 0, links: ['Acme GmbH, Clients', 'Onboarding template, Docs'], body: 'Standard onboarding from the template. Starts after the contract is signed.' },
      { t: 'Thesis chapter 2', s: 'In progress', c: 'University', due: 'Nov 28', start: 10, len: 40, roll: '3/8', agent: 1, links: ['Literature, Sources', 'Lecture 4, Notes', 'Supervisor, People'], body: 'Interval estimation. The researcher agent collected 14 sources; the writer drafts 2.3 from your lecture notes.' },
      { t: 'Hiring: designer', s: 'Blocked', c: 'Internal', due: 'Dec 10', start: 46, len: 34, roll: '1/6', agent: 0, links: ['Candidates, People', 'Job post, Docs'], body: 'Waiting for budget approval before the post goes live.' },
      { t: 'Lumen API integration', s: 'In progress', c: 'Lumen Labs', due: 'Nov 30', start: 22, len: 36, roll: '5/11', agent: 0, links: ['Lumen Labs, Clients', 'API notes, Docs', 'Runs, Logs'], body: 'Webhook handler done, auth flow in review. Runs land in the Logs database.' },
      { t: 'Offsite planning', s: 'Done', c: 'Internal', due: 'Nov 7', start: 0, len: 14, roll: '6/6', agent: 0, links: ['Agenda, Docs', 'Budget 2026, Finance'], body: 'Booked, budgeted, agenda shared.' },
      { t: 'Polar Studio proposal', s: 'Review', c: 'Polar Studio', due: 'Nov 19', start: 14, len: 18, roll: '2/3', agent: 1, links: ['Polar Studio, Clients', 'Pricing, Docs'], body: 'Draft by the writer agent, marked. Needs your pricing decision on page 2.' }
    ];
    this.statusBg = { 'In progress': 'var(--marker)', 'Review': 'var(--status-review)', 'Ready': 'var(--status-ready)', 'Blocked': 'var(--status-blocked)', 'Done': 'var(--status-neutral, var(--selected))' };
    this.logPool = [
      ['Main agent', 'Morning briefing written', 'ok'], ['Researcher', '14 sources linked to Thesis ch. 2', 'ok'], ['Night shift', '7 voice notes filed', 'ok'],
      ['Coder', 'Budget formula fixed', 'ok'], ['Writer', 'Proposal draft for Polar Studio', 'review'], ['Main agent', 'Asked for approval: Acme pricing', 'waiting'],
      ['Reviewer', '2 citations corrected', 'ok'], ['Sync', 'Deploy webhook received', 'ok'], ['Researcher', 'Competitor table refreshed', 'ok']
    ];
  }
  static split(text, start, step) {
    let i = 0;
    return text.split(' ').map((w, wi, arr) => ({ sp: wi < arr.length - 1 ? ' ' : '', chars: w.split('').map((c) => ({ c, d: (start + (i++) * step) + 'ms' })) }));
  }
  componentDidMount() {
    this.tick = setInterval(() => {
      const cycle = this.cycleLen();
      const t = this.state.t + 50 >= cycle ? 0 : this.state.t + 50;
      this.setState({ t });
    }, 50);
    this.slow = setInterval(() => this.setState({ logN: this.state.logN + 1, cipherSeed: this.state.cipherSeed + 1 }), 1800);
  }
  componentWillUnmount() { clearInterval(this.tick); clearInterval(this.slow); }
  cycleLen() { return Math.max(6000, 40 * this.state.factor + 3000); }
  cipher(seed) {
    const a = 'abcdef0123456789';
    let s = '', x = seed * 9301 + 49297;
    for (let i = 0; i < 44; i++) { x = (x * 9301 + 49297) % 233280; s += a[x % 16]; if (i % 4 === 3) s += ' '; }
    return s.trim();
  }
  renderVals() {
    const theme = this.props.theme ?? 'light';
    const dark = theme === 'dark';
    const s = this.state;
    const f = s.factor;
    const basedMs = 40 * f;
    const elapsed = Math.min(s.t, basedMs);
    const prog = Math.min(1, s.t / basedMs);
    const at = (p) => (prog >= p ? 1 : 0);
    const leftDoneAt = 4200;
    const leftLoading = f === 1 ? s.t < leftDoneAt : true;
    const leftMsgs = ['Loading…', 'Still loading…', 'Loading 3 databases…', 'Almost…', 'Any second now…'];
    let leftMsg = leftMsgs[Math.min(4, Math.floor(s.t / 900))];
    if (f > 1) leftMsg = f === 10 ? 'At 10× this would take 42 seconds. We spared you.' : 'At 100× this would take 7 minutes. Go get a coffee. Or don’t.';
    const leftSec = f === 1 ? Math.min(s.t, leftDoneAt) / 1000 : (s.t / 1000);
    const cols = [
      { t: 'To do', items: ['Budget review', 'Hiring plan'], p: 0.45 },
      { t: 'Doing', items: ['Q4 OKRs', 'Launch page'], p: 0.65 },
      { t: 'Done', items: ['Offsite', 'Retro notes'], p: 0.85 }
    ];
    const q = s.q.trim().toLowerCase();
    const filtered = this.projects.map((p, i) => Object.assign({ i }, p)).filter((p) => (s.status === 'all' || p.s === s.status) && (!q || (p.t + ' ' + p.c).toLowerCase().includes(q)));
    const mk = (p) => ({
      t: p.t, s: p.s, c: p.c, due: p.due, roll: p.roll, agent: p.agent,
      sbg: this.statusBg[p.s], bg: s.peek === p.i ? 'var(--surface-raised)' : 'transparent',
      left: (p.start * 1.1) + '%', width: (p.len * 1.1) + '%',
      open: () => this.setState({ peek: p.i })
    });
    const rows = filtered.map(mk);
    const boardOrder = ['Ready', 'In progress', 'Review', 'Blocked'];
    const board = boardOrder.map((st) => { const cards = filtered.filter((p) => p.s === st).map(mk); return { t: st, n: String(cards.length), cards }; });
    const pk = s.peek >= 0 ? this.projects[s.peek] : null;
    const logRows = [];
    for (let k = 0; k < 7; k++) {
      const n = s.logN - k;
      const L = this.logPool[((n % this.logPool.length) + this.logPool.length) % this.logPool.length];
      const mins = (n * 7) % 60;
      logRows.push({ time: String(8 + Math.floor(n / 9) % 12).padStart(2, '0') + ':' + String(mins).padStart(2, '0'), agent: L[0], what: L[1], s: L[2], bg: L[2] === 'ok' ? 'var(--status-ready)' : L[2] === 'review' ? 'var(--status-review)' : 'var(--marker)' });
    }
    const ticks = [];
    for (let i = 0; i < 40; i++) { const big = i % 7 === 0; const ag = i % 5 === 3; ticks.push({ left: (i * 2.5) + '%', top: big ? '12px' : '18px', h: big ? '32px' : '20px', c: ag ? 'var(--marker-strong)' : 'var(--control-border)' }); }
    const notes = ['Acme: send proposal Friday', 'Thesis: 14 sources linked', 'Budget: approve Q1 hiring'];
    return {
      theme,
      heroLabel: 'Big databases. Zero waiting.',
      hero1: Component.split('Big databases.', 0, 26),
      hero2: Component.split('Zero waiting.', 420, 26),
      markSrc: dark ? '/_blob/60426240b69c9dab9372c2741257d898' : '/_blob/c3ccc021887376abcf7fe08d0002d913',
      speeds: [1, 10, 100].map((x) => ({ label: x === 1 ? 'Real time' : x + '×', on: f === x ? 'true' : 'false', bg: f === x ? 'var(--bg)' : 'transparent', sh: f === x ? '0 1px 2px rgba(0,0,0,.1)' : 'none', pick: () => this.setState({ factor: x, t: 0 }) })),
      leftLoading, leftDone: !leftLoading, leftMsg,
      leftTime: leftSec.toFixed(1) + ' s',
      rightTime: (elapsed / f).toFixed(f === 1 ? 2 : 3) + ' s' + (f > 1 ? ' (shown ' + f + '× slower)' : ''),
      r1: at(0.15), r1y: at(0.15) ? '0' : '6px', r2: at(0.3),
      raceCols: cols.map((c) => ({ t: c.t, items: c.items, o: at(c.p), y: at(c.p) ? '0' : '10px' })),
      rightNote: prog >= 1 ? 'Done. Nothing was downloaded.' : 'Reading from disk…',
      views: [['table', 'Table'], ['board', 'Board'], ['timeline', 'Timeline']].map(([id, label]) => ({ label, on: s.view === id ? 'true' : 'false', bg: s.view === id ? 'var(--bg)' : 'transparent', sh: s.view === id ? '0 1px 2px rgba(0,0,0,.1)' : 'none', pick: () => this.setState({ view: id }) })),
      isTable: s.view === 'table', isBoard: s.view === 'board', isTimeline: s.view === 'timeline',
      q: s.q, setQ: (e) => this.setState({ q: e.target.value }),
      chips: [['all', 'All'], ['In progress', 'In progress'], ['Review', 'Review'], ['Blocked', 'Blocked']].map(([id, label]) => ({ label, on: s.status === id ? 'true' : 'false', bg: s.status === id ? 'var(--button)' : 'var(--surface-raised)', fg: s.status === id ? 'var(--button-ink)' : 'var(--ink)', pick: () => this.setState({ status: id }) })),
      countTxt: filtered.length + ' of ' + this.projects.length + ', filtered locally in <1 ms',
      rows, board,
      peekOpen: !!pk,
      peek: pk ? { t: pk.t, s: pk.s, c: pk.c, due: pk.due, body: pk.body, links: pk.links, agentOn: !!pk.agent } : { t: '', s: '', c: '', due: '', body: '', links: [], agentOn: false },
      closePeek: () => this.setState({ peek: -1 }),
      dbFeatures: [
        { t: 'Six views, one source', d: 'Table, board, list, gallery, calendar, timeline. Same rows, any shape.', planned: false },
        { t: 'Relations and rollups', d: 'Link clients to projects to invoices and roll numbers up the chain.', planned: false },
        { t: 'Formulas', d: 'The formula language you know, evaluated locally and offline.', planned: false },
        { t: 'Linked views', d: 'Show a filtered slice of any database inside any page.', planned: false },
        { t: 'Pages in every row', d: 'Every row opens as a full page with blocks, sub-pages and comments.', planned: false },
        { t: 'Templates', d: 'Row templates for meetings, clients, lectures, bug reports.', planned: false },
        { t: 'Sub-items and dependencies', d: 'Nested tasks and blocked-by relations.', planned: true },
        { t: 'Automations', d: 'When a property changes, do something. Or ask an agent to.', planned: true }
      ],
      logCount: (2400 + s.logN).toLocaleString('en-US'),
      logRows,
      copies: [
        { n: '1', t: 'On your device', d: 'Your workspace is a local database. Works offline, survives any outage.', status: 'current' },
        { n: '2', t: 'In your cloud', d: 'iCloud in the beta. At release, Based Cloud on EU servers, end-to-end encrypted. Lose your laptop, keep your work.', status: 'synced 2 s ago' },
        { n: '3', t: 'In your backup folder', d: 'Automatic snapshots to a drive or folder you choose, as a readable archive.', status: 'last snapshot 4 min ago' }
      ],
      ticks,
      syncPlain: notes[s.cipherSeed % notes.length],
      syncCipher: this.cipher(s.cipherSeed)
    };
  }
}
