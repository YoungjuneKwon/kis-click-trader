import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Activity, ArrowDown, ArrowDownRight, ArrowRight, ArrowUp, ArrowUpRight, Check, ChevronDown, CircleHelp, KeyRound, LockKeyhole, Power, Radio, Settings2, ShieldCheck, Unplug, X } from 'lucide-react';
import { clock, credentialsSchema, ruleSchema, signed, symbols, won, type Book, type Broker, type Credentials, type Rule, type Snapshot, type SymbolInfo } from './model';
import { deleteCredentials, hasCredentials, loadPreferences, saveCredentials, savePreferences, saveSnapshot, sessions, unlockCredentials } from './storage';
import { TradingEngine } from './engine';
import { DemoBroker } from './demo';
import { KisBroker } from './kis';

const initial = loadPreferences();
const PerformanceChart = lazy(() => import('./PerformanceChart'));
const stateLabel = { protecting: '익절 등록 중', protected: '감시 중', stopping: '청산 정정 중', closed: '청산 완료', unknown: '주문 확인 필요' };
function errorText(e: unknown) { return e instanceof Error ? e.message : '처리에 실패했습니다.'; }

export default function App() {
  const [selected, setSelected] = useState<SymbolInfo>(symbols.find(s => s.code === initial.symbol) || symbols[0]);
  const [quantity, setQuantity] = useState(initial.quantity);
  const [rule, setRule] = useState<Rule>(initial.rule);
  const [mode, setMode] = useState<'demo' | 'kis'>('demo');
  const [status, setStatus] = useState('idle');
  const [book, setBook] = useState<Book>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [message, setMessage] = useState('');
  const [keyError, setKeyError] = useState('');
  const [busy, setBusy] = useState(false);
  const [credentials, setCredentials] = useState<Credentials>();
  const [stored, setStored] = useState(false);
  const [credentialTab, setCredentialTab] = useState<'new' | 'unlock'>('new');
  const [advanced, setAdvanced] = useState(false);
  const [help, setHelp] = useState(false);
  const [manualSymbol, setManualSymbol] = useState('');
  const [customSymbol, setCustomSymbol] = useState<SymbolInfo>();
  const [now, setNow] = useState(Date.now());
  const engine = useRef<TradingEngine | null>(null);
  const broker = useRef<Broker | null>(null);
  const release = useRef<(() => void) | undefined>(undefined);
  const poll = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const keyPopover = useRef<HTMLDivElement>(null);
  const exitDialog = useRef<HTMLDialogElement>(null);
  const bookElement = useRef<HTMLDivElement>(null);
  const quantityHeld = snapshot?.lots.reduce((n, l) => n + l.qty - l.sold, 0) || 0;
  const exposed = !!snapshot && (snapshot.entries.some(e => e.state !== 'done') || snapshot.lots.some(l => l.state !== 'closed'));
  const activeLots = snapshot?.lots.filter(l => l.state !== 'closed') || [];
  const pending = snapshot?.entries.filter(e => e.state !== 'done') || [];
  const trades = snapshot?.trades || [];
  const net = trades.reduce((n, t) => n + t.net, 0);
  const cost = trades.reduce((n, t) => n + t.cost, 0);
  const bid = book?.bids[0]?.price || 0;
  const unrealized = activeLots.reduce((n, l) => n + (bid - l.entry) * (l.qty - l.sold), 0);
  const connected = status === 'demo' || status === 'connected';
  const stale = !!book && now - book.time > 10000;

  useEffect(() => { void hasCredentials().then(v => { setStored(v); if (v) setCredentialTab('unlock'); }).catch(e => setMessage(errorText(e))); const timer = setInterval(() => setNow(Date.now()), 1000); return () => { clearInterval(timer); clearInterval(poll.current); broker.current?.disconnect(); release.current?.(); }; }, []);
  useEffect(() => { try { savePreferences({ symbol: selected.code, quantity, rule }); } catch { setMessage('브라우저 설정 저장에 실패했습니다.'); } }, [selected, quantity, rule]);
  useEffect(() => { const el = bookElement.current; if (el && book) el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2); }, [book?.symbol]);
  useEffect(() => {
    if (!exposed) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [exposed]);
  async function acquire() {
    if (release.current) return;
    if (!navigator.locks) throw new Error('이 브라우저는 단일 거래 탭 잠금을 지원하지 않습니다. 최신 브라우저의 HTTPS 또는 localhost에서 실행해 주세요.');
    await new Promise<void>((resolve, reject) => {
      void navigator.locks.request('click-trader-engine', { ifAvailable: true }, lock => {
        if (!lock) { reject(new Error('다른 탭에서 거래 엔진이 실행 중입니다. 그 탭에서 연결을 종료해 주세요.')); return; }
        return new Promise<void>(unlock => { release.current = unlock; resolve(); });
      }).catch(reject);
    });
  }
  async function connect(nextMode = mode, nextSymbol = selected, supplied = credentials) {
    if (busy) return;
    if (exposed) {
      if (nextMode !== mode || nextSymbol.code !== selected.code) { setMessage('보유·미체결 주문을 모두 정리한 뒤 연결이나 종목을 바꿔 주세요.'); return; }
      setBusy(true); setMessage('');
      try { await broker.current!.connect(selected.code, b => engine.current!.onBook(b), setStatus, () => { void engine.current!.sync().catch(e => setMessage(errorText(e))); }); await engine.current!.sync(); }
      catch (e) { setMessage(errorText(e)); setStatus('error'); }
      finally { setBusy(false); }
      return;
    }
    setBusy(true); setMessage(''); setStatus('connecting');
    let next: Broker | undefined;
    try {
      if (nextMode === 'kis' && !supplied) { keyPopover.current?.showPopover(); throw new Error('먼저 키를 입력하거나 저장된 키를 잠금 해제해 주세요.'); }
      if (nextMode === 'kis' && supplied?.env === 'vps') throw new Error('KIS 모의계좌의 정정가능조회 지원은 미검증입니다. 이 버전의 자동 청산은 내장 데모 또는 실전 어댑터로 제공합니다.');
      await acquire(); clearInterval(poll.current); broker.current?.disconnect(); setBook(undefined);
      next = nextMode === 'demo' ? new DemoBroker() : new KisBroker(supplied!);
      const tag = nextMode === 'demo' ? 'demo' : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${supplied!.env}:${supplied!.cano}:${supplied!.product}:${supplied!.appKey}`)))).map(n => n.toString(16).padStart(2, '0')).join('');
      const history = await sessions();
      const restored = nextMode === 'kis' ? history.find(s => s.kind === 'kis' && s.accountTag === tag && (s.entries.some(e => e.state !== 'done') || s.lots.some(l => l.state !== 'closed'))) : undefined;
      if (restored && restored.started < new Date().setHours(0, 0, 0, 0)) throw new Error('이전 날짜의 미종결 거래가 있습니다. HTS에서 잔고·주문을 대조해야 합니다. 이 PoC는 당일 주문만 복구합니다.');
      const restoredSymbol = restored?.lots.find(l => l.state !== 'closed')?.symbol || restored?.entries.find(e => e.state !== 'done')?.symbol;
      if (restoredSymbol && restoredSymbol !== nextSymbol.code) { const s = symbols.find(s => s.code === restoredSymbol) || { code: restoredSymbol, name: restoredSymbol, base: 0 }; setSelected(s); nextSymbol = s; }
      const instance = new TradingEngine(next, saveSnapshot, () => { if (engine.current === instance) { setSnapshot(structuredClone(instance.state)); setBook(instance.book); } }, tag, restored);
      engine.current = instance; broker.current = next; setSnapshot(structuredClone(instance.state)); setMode(nextMode); setSelected(nextSymbol);
      await next.connect(nextSymbol.code, b => instance.onBook(b), s => setStatus(s), () => { void instance.sync().catch(e => setMessage(errorText(e))); });
      await saveSnapshot(instance.state);
      poll.current = setInterval(() => { if (instance.exposed) void instance.sync().catch(e => setMessage(errorText(e))); }, nextMode === 'demo' ? 800 : 3000);
      if (restored) { instance.log('저장된 주문 상태 복원 · KIS 체결 내역 대조'); await instance.sync(); }
      if (next instanceof KisBroker) {
        const actual = await next.inventory(nextSymbol.code);
        if (actual.qty < instance.quantity) { for (const lot of instance.state.lots) if (lot.state !== 'closed') lot.state = 'unknown'; await saveSnapshot(instance.state); throw new Error('실제 잔고가 저장된 관리 수량보다 적습니다. 외부 거래 내역을 확인해 주세요.'); }
        instance.log(`계좌 잔고 대조: ${actual.qty}주 · 이 앱 관리 ${instance.quantity}주. 기존 보유분은 자동 편입하지 않습니다.`);
      }
    } catch (e) {
      setMessage(errorText(e)); setStatus('error');
      if (!engine.current?.exposed) { next?.disconnect(); release.current?.(); release.current = undefined; }
    } finally { setBusy(false); }
  }
  function disconnect() {
    if (engine.current?.exposed) { exitDialog.current?.showModal(); return; }
    clearInterval(poll.current); broker.current?.disconnect(); release.current?.(); release.current = undefined; setStatus('idle'); setBook(undefined); exitDialog.current?.close();
  }
  async function buy() {
    if (!engine.current || !connected || busy || stale) return;
    const validation = ruleSchema.safeParse(rule); if (!validation.success) { setMessage('익절·손절은 0보다 크게, 비용률은 0~5%로 설정해 주세요.'); return; }
    setBusy(true); setMessage('');
    try { await engine.current.buy(selected, quantity, rule); } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  async function closeAll() {
    if (!engine.current) return; setBusy(true); setMessage('');
    try { await engine.current.closeAll(); await engine.current.sync(); } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  async function handleKeys(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setKeyError('');
    const element = event.currentTarget;
    const form = new FormData(element);
    try {
      let value: Credentials;
      if (credentialTab === 'unlock') value = await unlockCredentials(String(form.get('password')));
      else { const parsed = credentialsSchema.safeParse(Object.fromEntries(form)); if (!parsed.success) throw new Error(parsed.error.issues[0].message); value = parsed.data; await saveCredentials(value, String(form.get('password'))); setStored(true); }
      setCredentials(value); element.reset(); setCredentialTab('unlock'); keyPopover.current?.hidePopover(); setMessage('키를 잠금 해제했습니다. KIS 연결을 선택하면 인증을 시작합니다.');
    } catch (e) { setKeyError(errorText(e)); } finally { setBusy(false); }
  }
  function exportTrades() {
    const text = JSON.stringify({ exported: new Date().toISOString(), session: snapshot }, null, 2);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = 'click-trader-session.json'; a.click(); URL.revokeObjectURL(a.href);
  }
  async function forgetKeys() {
    try {
      if (engine.current?.exposed) throw new Error('미종결 주문이 있어 키를 삭제할 수 없습니다.');
      disconnect(); broker.current = null; engine.current = null;
      await deleteCredentials(); setCredentials(undefined); setStored(false); setCredentialTab('new'); setKeyError('');
      setMessage('저장된 키와 토큰을 삭제했습니다.');
    } catch (e) { setKeyError(errorText(e)); }
  }
  const options = customSymbol && !symbols.some(s => s.code === customSymbol.code) ? [...symbols, customSymbol] : symbols;
  const maxQty = Math.max(1, ...(book?.asks.map(a => a.qty) || []), ...(book?.bids.map(b => b.qty) || []));
  const total = (book?.totalAsk || 0) + (book?.totalBid || 0);
  const stateText = status === 'idle' ? '연결 대기' : status === 'demo' ? '데모 실행 중' : status === 'connected' ? 'KIS 연결됨' : status === 'connecting' ? '연결 중' : status === 'error' ? '연결 실패' : status === 'disconnected' ? '연결 끊김' : status;

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="./"><span className="brand-mark"><Activity size={21} strokeWidth={2.2} /></span><span>click<span className="brand-light">trader</span><sup>POC</sup></span></a>
      <div className="top-actions"><span className="local-badge"><LockKeyhole size={13} /> 로컬 퍼스트</span><button className="button subtle key-button" popoverTarget="key-popover"><KeyRound size={16} />{credentials ? '키 연결됨' : stored ? '키 잠금 해제' : '키 입력'}</button><button className="icon-button" aria-label="사용 안내" onClick={() => setHelp(!help)}><CircleHelp size={18} /></button></div>
    </header>
    <main>
      <section className="page-heading"><div><div className="eyebrow">YOUR ENTRY. YOUR RULES.</div><h1>진입은 직접, 청산은 규칙대로.</h1><p>호가를 보고 매수하세요. 익절과 손절은 설정한 규칙이 이어받습니다.</p></div><button className="button subtle end-button" onClick={() => exitDialog.current?.showModal()}><Power size={15} /> 거래 종료</button></section>
      {help && <section className="notice help"><ShieldCheck size={18} /><div><strong>이 화면이 열려 있는 동안 자동 청산이 동작합니다.</strong><p>데모는 합성 호가·가상 체결입니다. KIS 연결은 실제 WebSocket 호가와 REST 주문을 사용합니다. 실현손익은 이 세션 거래와 입력한 비용률을 기준으로 한 추정치이며, 계좌 전체 손익은 아닙니다. 손절은 지정가 정정으로 실행되어 체결 가격·시점을 보장하지 않습니다.</p><p>정적 호스팅에서는 KIS CORS 및 ws:// 혼합 콘텐츠 제한이 있습니다. 로컬 실행의 개발 릴레이로 연결을 검증할 수 있습니다. 탭 종료·절전·네트워크 단절 시 손절 감시는 중단됩니다.</p></div><button className="icon-button" aria-label="안내 닫기" onClick={() => setHelp(false)}><X size={16} /></button></section>}
      <section className="connection-bar"><div className="mode-tabs" aria-label="연결 모드"><button className={mode === 'demo' ? 'active' : ''} disabled={exposed || busy} onClick={() => { disconnect(); setMode('demo'); }}>데모</button><button className={mode === 'kis' ? 'active' : ''} disabled={exposed || busy} onClick={() => { disconnect(); setMode('kis'); }}>KIS {credentials?.env === 'vps' ? '모의' : '실전'}</button></div><span className={`connection-state ${connected ? 'online' : ''}`}><i />{stateText}</span><span className="connection-caption">{mode === 'demo' ? '합성 시세 · 실제 주문 없음' : 'KRX · 체결 / 호가 WebSocket'}</span><button className="button connection-button" disabled={busy} onClick={() => connected ? disconnect() : void connect()}>{connected ? <Unplug size={14} /> : <Radio size={14} />}{connected ? '연결 종료' : '연결 시작'}</button></section>
      {message && <div className="notice message" role="status"><Activity size={16} /><span>{message}</span><button className="icon-button" aria-label="메시지 닫기" onClick={() => setMessage('')}><X size={15} /></button></div>}
      {stale && <div className="notice warning">호가 수신이 10초 이상 지연되었습니다. 신규 매수가 중지됩니다. 연결 상태를 확인해 주세요.</div>}
      <div className="workspace">
        <section className="card market-card">
          <div className="section-top"><span className="section-label">MARKET</span><span className="tiny-status"><i className={connected ? 'pulse-dot' : ''} />{book ? clock(book.time) : '시세 대기'}</span></div>
          <div className="stock-heading"><div className="stock-avatar">{selected.name.slice(0, 1)}</div><div className="stock-select"><select aria-label="종목 선택" value={selected.code} disabled={exposed || busy} onChange={e => { const s = options.find(s => s.code === e.target.value)!; setSelected(s); if (connected) void connect(mode, s); }} >{options.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}</select><ChevronDown size={14} /><span>{selected.code} <span className="exchange-label">KRX</span></span></div><div className="stock-price"><strong>{book ? won(book.last || bid) : '—'}</strong><span>{book ? '원 · 실시간 호가 기준' : '연결 후 호가가 표시됩니다'}</span></div></div>
          <details className="symbol-details"><summary>종목코드로 선택</summary><form onSubmit={e => { e.preventDefault(); if (!/^\d{6}$/.test(manualSymbol)) { setMessage('종목코드 6자리를 입력해 주세요.'); return; } const s = symbols.find(s => s.code === manualSymbol) || { code: manualSymbol, name: manualSymbol, base: 50000 }; setCustomSymbol(s); setSelected(s); if (connected) void connect(mode, s); }}><input aria-label="직접 입력 종목코드" placeholder="6자리 종목코드" inputMode="numeric" maxLength={6} value={manualSymbol} onChange={e => setManualSymbol(e.target.value.replace(/\D/g, ''))} disabled={exposed || busy} /><button className="button subtle" disabled={exposed || busy}>선택</button></form></details>
          <div className="book-head"><span>매도 잔량</span><span>호가 (원)</span><span>매수 잔량</span></div>
          <div className="orderbook" aria-label="10단계 호가창" ref={bookElement}>
            {book ? <>
              {[...book.asks].reverse().map((a, i) => <div className="book-row ask" key={`a${i}`}><div className="depth-cell"><span className="depth-bar" style={{ width: `${a.qty / maxQty * 100}%` }} /><span>{won(a.qty)}</span></div><strong>{won(a.price)}</strong><span /></div>)}
              <div className="spread"><span>스프레드</span><strong>{won(book.asks[0].price - book.bids[0].price)}원</strong><span>{mode === 'demo' ? 'SIMULATED' : 'LIVE KRX'}</span></div>
              {book.bids.map((b, i) => <div className="book-row bid" key={`b${i}`}><span /><strong>{won(b.price)}</strong><div className="depth-cell"><span className="depth-bar" style={{ width: `${b.qty / maxQty * 100}%` }} /><span>{won(b.qty)}</span></div></div>)}
            </> : <div className="empty-book"><Radio size={30} strokeWidth={1.3} /><strong>시장을 연결해 주세요</strong><p>데모로 흐름을 살펴보거나<br />키 입력 후 KIS에 연결하세요.</p><button className="button subtle" disabled={busy} onClick={() => void connect()}>호가 연결 <ArrowRight size={14} /></button></div>}
          </div>
          <div className="book-total"><span className="ask-text">{won(book?.totalAsk || 0)}</span><span>총 잔량</span><span className="bid-text">{won(book?.totalBid || 0)}</span></div><div className="imbalance"><span style={{ width: `${total ? (book!.totalAsk / total * 100) : 50}%` }} /></div>
          {mode === 'demo' && connected && <div className="demo-controls"><span>데모 가격 움직이기</span><button aria-label="데모 가격 하락" onClick={() => (broker.current as DemoBroker).move(-1)}><ArrowDown size={13} /> 하락</button><button aria-label="데모 가격 상승" onClick={() => (broker.current as DemoBroker).move(1)}><ArrowUp size={13} /> 상승</button></div>}
        </section>
        <div className="trading-column">
          <section className="card trade-card"><div className="section-top"><span className="section-label">QUICK BUY</span><span className="pill">최유리 지정가</span></div><h2>한 번의 클릭으로 진입</h2><p className="muted small">체결 즉시 익절 주문, 손절은 호가로 감시합니다.</p>
            <div className="field-title">매수 수량 <span>주</span></div><div className="quantity-control"><button aria-label="매수 수량 줄이기" disabled={quantity <= 1} onClick={() => setQuantity(Math.max(1, quantity - 1))}>−</button><input aria-label="매수 수량" type="number" min="1" max="100000" value={quantity} onChange={e => setQuantity(Math.min(100000, Math.max(1, Math.trunc(Number(e.target.value) || 1))))} /><button aria-label="매수 수량 늘리기" onClick={() => setQuantity(Math.min(100000, quantity + 1))}>+</button></div><div className="quantity-presets">{[1, 5, 10].map(n => <button key={n} className={quantity === n ? 'selected' : ''} onClick={() => setQuantity(n)}>{n}주</button>)}</div>
            <div className="rule-heading"><span className="field-title">자동 청산 규칙</span><div className="unit-tabs"><button className={rule.unit === 'won' ? 'active' : ''} onClick={() => setRule({ ...rule, unit: 'won', take: 500, stop: 300 })}>금액</button><button className={rule.unit === 'percent' ? 'active' : ''} onClick={() => setRule({ ...rule, unit: 'percent', take: 1, stop: .5 })}>비율</button></div></div>
            <div className="rule-inputs"><label><span><ArrowUpRight size={14} /> 익절</span><div><span className="sign">+</span><input aria-label="익절 기준" type="number" min="0.01" step={rule.unit === 'won' ? 100 : .1} value={rule.take} onChange={e => setRule({ ...rule, take: Number(e.target.value) })} /><span>{rule.unit === 'won' ? '원' : '%'}</span></div></label><label><span><ArrowDownRight size={14} /> 손절</span><div><span className="sign">−</span><input aria-label="손절 기준" type="number" min="0.01" step={rule.unit === 'won' ? 100 : .1} value={rule.stop} onChange={e => setRule({ ...rule, stop: Number(e.target.value) })} /><span>{rule.unit === 'won' ? '원' : '%'}</span></div></label></div>
            <p className="rule-note">실제 체결가 기준 · 금액은 1주당 가격 차이<br />기존 포지션의 규칙은 유지됩니다.</p>
            <div className="estimated"><span>예상 주문 금액</span><strong>{book ? `${won((book.asks[0]?.price || 0) * quantity)}원` : '—'}</strong></div>
            <button className="buy-button" disabled={!connected || busy || stale || engine.current?.uncertain || !ruleSchema.safeParse(rule).success} onClick={() => void buy()}><span>{busy ? '처리 중…' : `${quantity}주 매수`}</span><ArrowRight size={20} /></button><p className="buy-caption">{mode === 'demo' ? '데모 주문 · 실제 계좌에 영향을 주지 않습니다' : '실제 계좌 주문 · 체결 가격은 호가에 따라 달라집니다'}</p>
          </section>
          <section className="card position-card"><div className="section-top"><span className="section-label">POSITION</span><span className={`pill ${quantityHeld ? 'green' : ''}`}><ShieldCheck size={12} />{quantityHeld ? '자동 청산 관리' : '진입 대기'}</span></div><div className="position-summary"><div><span className="muted small">보유 수량</span><strong>{quantityHeld}<small>주</small></strong></div><div className="right"><span className="muted small">평가손익 · 비용 전</span><strong className={unrealized >= 0 ? 'positive' : 'negative'}>{quantityHeld ? signed(unrealized) : '0'}<small>원</small></strong></div></div>
            {pending.map(e => <div className="pending-order" key={e.id}>{e.name} 매수 {e.filled}/{e.qty}주 · {e.state === 'unknown' || e.state === 'sending' ? '응답 확인 필요 · HTS 주문내역 대조' : '미체결 감시 중'}</div>)}
            {activeLots.length ? <div className="lot-list">{activeLots.map(l => <div className="lot" key={l.id}><div><strong>{l.name} {l.qty - l.sold}주</strong><span>{won(l.entry)}원 진입</span></div><div className="right"><strong className={l.state === 'unknown' ? 'negative' : ''}>{stateLabel[l.state]}</strong><span>익절 {won(l.target)} · 손절 {l.stop > 0 ? won(l.stop) : '청산 진행'}</span></div></div>)}</div> : <p className="position-empty">{pending.length ? '매수 체결을 기다리고 있습니다.' : '체결된 포지션이 여기에 표시됩니다.'}</p>}
            {exposed && <button className="button full subtle" disabled={busy || !connected} onClick={() => void closeAll()}>보유 수량 청산</button>}
          </section>
        </div>
        <section className="card performance-card"><div className="section-top"><span className="section-label">SESSION PERFORMANCE</span><span className="pill">실현손익 · 비용 추정 반영</span></div><div className="performance-heading"><div><p className="muted small">이번 세션 누적 실현손익</p><strong className={`pnl-number ${net > 0 ? 'positive' : net < 0 ? 'negative' : ''}`}>{signed(net)}<small>원</small></strong></div><div className="session-date">{new Date(now).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })}<span>{snapshot ? `${clock(snapshot.started)} 시작` : '세션 대기'}</span></div></div>
          <Suspense fallback={<div className="pnl-chart" />}><PerformanceChart trades={trades} started={snapshot?.started || now} now={now} /></Suspense>
          <div className="metrics"><div><span>청산 체결</span><strong>{trades.length}<small>건</small></strong></div><div><span>승률 · 순손익 기준</span><strong>{trades.length ? Math.round(trades.filter(t => t.net > 0).length / trades.length * 100) : '—'}<small>{trades.length ? '%' : ''}</small></strong></div><div><span>추정 거래 비용</span><strong>{won(cost)}<small>원</small></strong></div></div>
          <div className="history-heading"><h3>체결 기록</h3><button className="text-button" onClick={exportTrades} disabled={!snapshot}>내보내기 <ArrowDown size={12} /></button></div>
          <div className="trade-history">{trades.length ? [...trades].reverse().map(t => <div className="trade-row" key={t.id}><span className={`trade-icon ${t.net >= 0 ? 'gain' : 'loss'}`}>{t.net >= 0 ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}</span><div><strong>{t.name} <span>{t.qty}주 · {t.reason}</span></strong><small>{clock(t.time)} · {won(t.entry)} → {won(t.exit)}</small></div><strong className={t.net >= 0 ? 'positive' : 'negative'}>{signed(t.net)}<small>원</small></strong></div>) : <div className="empty-history"><Check size={17} /><span>아직 청산된 거래가 없습니다.</span></div>}</div>
          <div className="cost-settings"><button className="text-button" onClick={() => setAdvanced(!advanced)}><Settings2 size={13} /> 비용률 설정 <ChevronDown size={12} /></button>{advanced && <div className="cost-fields">{([['buyFee', '매수 수수료'], ['sellFee', '매도 수수료'], ['tax', '매도 세금']] as const).map(([key, label]) => <label key={key}>{label} (%)<input type="number" min="0" max="5" step="0.001" value={rule[key]} onChange={e => setRule({ ...rule, [key]: Number(e.target.value) })} /></label>)}<p>예시 비용률입니다. 본인 계좌·종목에 맞게 수정해 주세요. 변경 후 매수부터 적용됩니다.</p></div>}</div>
        </section>
      </div>
      <section className="card activity-card"><div className="section-top"><span className="section-label">ACTIVITY</span><button className="text-button" disabled={!connected} onClick={() => void engine.current?.sync().catch(e => setMessage(errorText(e)))}>주문 상태 대조</button></div>{snapshot?.logs.length ? <div className="activity-list">{snapshot.logs.slice(0, 8).map(l => <div key={l.id} className={l.level === 'error' ? 'log-error' : ''}><time>{clock(l.time)}</time><span>{l.message}</span></div>)}</div> : <p className="muted small">연결·주문·자동 청산 이벤트가 여기에 기록됩니다.</p>}</section>
      <footer><span><ShieldCheck size={14} /> 키는 이 브라우저에 암호화 저장됩니다.</span><span>탭이 닫히면 자동 손절 감시도 중단됩니다.</span><a href="https://github.com/YoungjuneKwon/kis-click-trader" target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={12} /></a></footer>
    </main>
    <div id="key-popover" ref={keyPopover} popover="auto" className="key-popover"><div className="popover-heading"><div><span className="section-label">LOCAL KEY VAULT</span><h2>내 계좌 연결</h2></div><button className="icon-button" popoverTarget="key-popover" popoverTargetAction="hide" aria-label="키 입력 닫기"><X size={18} /></button></div><p className="muted small">키는 외부 앱 서버에 저장하지 않습니다.<br />암호화한 뒤 이 브라우저의 IndexedDB에 보관합니다.</p>{stored && <div className="mode-tabs vault-tabs"><button className={credentialTab === 'unlock' ? 'active' : ''} onClick={() => setCredentialTab('unlock')}>잠금 해제</button><button className={credentialTab === 'new' ? 'active' : ''} onClick={() => setCredentialTab('new')}>새 키 입력</button></div>}
      <form onSubmit={e => void handleKeys(e)} autoComplete="off">{credentialTab === 'new' && <><label>App Key<input name="appKey" type="password" required autoComplete="off" placeholder="한국투자 App Key" /></label><label>App Secret<input name="appSecret" type="password" required autoComplete="off" placeholder="한국투자 App Secret" /></label><div className="form-columns"><label>계좌번호 앞 8자리<input name="cano" type="password" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} required /></label><label>상품코드<input name="product" defaultValue="01" inputMode="numeric" pattern="[0-9]{2}" maxLength={2} required /></label></div><label>HTS ID<input name="htsId" required placeholder="계좌 체결통보 구독에 사용" /></label><div className="form-columns"><label>환경<select name="env" defaultValue="prod"><option value="prod">실전</option><option value="vps">모의 · 자동 정정 미검증</option></select></label><label>연결 방식<select name="transport" defaultValue={import.meta.env.DEV ? 'relay' : 'direct'}><option value="direct">직접 연결</option><option value="relay">로컬 개발 릴레이</option></select></label></div></>}
      <label>{credentialTab === 'unlock' ? '잠금 해제 암호' : '키 저장 암호'}<input name="password" type="password" minLength={8} required autoComplete="off" placeholder="8자 이상 · 암호는 저장하지 않습니다" /></label>
      {keyError && <div className="notice warning" role="alert">{keyError}</div>}
      <p className="micro">{credentialTab === 'new' ? '정적 호스팅의 KIS 직접 연결은 CORS·혼합 콘텐츠로 제한됩니다. 릴레이는 npm run dev에서만 제공됩니다.' : '저장 당시의 연결 방식과 계좌 설정을 불러옵니다.'}</p>
      <button className="button primary full" disabled={busy}><LockKeyhole size={15} />{credentialTab === 'unlock' ? '잠금 해제' : '암호화하여 저장'}</button></form>
      {stored && <button className="text-button delete-key" disabled={exposed || busy} onClick={() => void forgetKeys()}>저장된 키 삭제</button>}
      <p className="micro">잠금 해제 후에는 이 페이지의 코드가 키를 사용합니다. 공유 기기에서는 사용 후 키를 삭제해 주세요.</p></div>
    <dialog ref={exitDialog} className="exit-dialog"><div className="popover-heading"><h2>거래를 마칠까요?</h2><button className="icon-button" aria-label="종료 창 닫기" onClick={() => exitDialog.current?.close()}><X size={18} /></button></div><p>{exposed ? `보유 ${quantityHeld}주 · 매수 확인 중 ${pending.length}건이 남아 있습니다. 화면을 닫으면 자동 손절 감시가 중단됩니다.` : '보유 수량과 미종결 주문이 없습니다. 연결을 종료할 수 있습니다.'}</p>{exposed && <p className="micro">미체결 매수·응답 불명확 주문은 HTS에서 확인·취소해 주세요. 청산 버튼은 체결된 보유 물량의 매도 주문만 정정합니다.</p>}<div className="dialog-actions"><button className="button subtle" onClick={() => exitDialog.current?.close()}>계속 거래</button>{exposed ? <button className="button primary" disabled={busy || !connected} onClick={() => void closeAll()}>보유 수량 청산</button> : <button className="button primary" onClick={disconnect}>연결 종료</button>}</div></dialog>
  </div>;
}
