import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Activity, ArrowDown, ArrowDownRight, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleHelp, LockKeyhole, Power, Radio, Settings2, ShieldCheck, Unplug, X } from 'lucide-react';
import { clock, ruleSchema, signed, symbols, won, type Book, type Broker, type ServerSession, type Rule, type Snapshot, type SymbolInfo } from './model';
import { clearClientSecrets, loadPreferences, savePreferences, saveSnapshot, sessions } from './storage';
import { TradingEngine } from './engine';
import { KisBroker } from './kis';
import { LockForm, SetupScreen, SymbolPicker } from './Setup';
import { lockServer, serverStatus, unlockServer } from './api';

const initial = loadPreferences();
const PerformanceChart = lazy(() => import('./PerformanceChart'));
const stateLabel = { protecting: '익절 등록 중', protected: '감시 중', stopping: '청산 정정 중', closed: '청산 완료', unknown: '주문 확인 필요' };
function errorText(e: unknown) { return e instanceof Error ? e.message : '처리에 실패했습니다.'; }

export default function App() {
  const [selected, setSelected] = useState<SymbolInfo | undefined>(initial.selected);
  const [quantity, setQuantity] = useState(initial.quantity);
  const [rule, setRule] = useState<Rule>(initial.rule);
  const [status, setStatus] = useState('idle');
  const [book, setBook] = useState<Book>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [message, setMessage] = useState('');
  const [authError, setAuthError] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<ServerSession>();
  const [sessionChecked, setSessionChecked] = useState(false);
  const [backendReady, setBackendReady] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [help, setHelp] = useState(false);
  const [now, setNow] = useState(Date.now());
  const engine = useRef<TradingEngine | null>(null);
  const broker = useRef<Broker | null>(null);
  const liveConnection = useRef(false);
  const release = useRef<(() => void) | undefined>(undefined);
  const poll = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
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
  const unrealized = book ? activeLots.reduce((n, l) => n + (bid - l.entry) * (l.qty - l.sold), 0) : undefined;
  const connected = status === 'connected';
  const stale = !!book && now - book.time > 10000;

  useEffect(() => {
    void clearClientSecrets().catch(e => setMessage(errorText(e)));
    void serverStatus().then(value => { setSession(value); setBackendReady(true); }).catch(e => { setBackendReady(false); setAuthError(errorText(e)); }).finally(() => setSessionChecked(true));
    const locked = () => { clearInterval(poll.current); broker.current?.disconnect(); release.current?.(); release.current = undefined; liveConnection.current = false; setBook(undefined); setStatus('idle'); setSession(undefined); setAuthError('서버 세션이 잠겼습니다. 다시 인증해 주세요.'); };
    window.addEventListener('click-trader:locked', locked);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { window.removeEventListener('click-trader:locked', locked); clearInterval(timer); clearInterval(poll.current); broker.current?.disconnect(); release.current?.(); };
  }, []);
  useEffect(() => { try { savePreferences({ selected, quantity, rule }); } catch { setMessage('브라우저 설정 저장에 실패했습니다.'); } }, [selected, quantity, rule]);
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
  async function connect(nextSymbol = selected) {
    if (busy) return;
    if (!session || !nextSymbol) return;
    if (exposed) {
      if (nextSymbol.code !== selected?.code) { setMessage('보유·미체결 주문을 모두 정리한 뒤 종목을 바꿔 주세요.'); return; }
      setBusy(true); setMessage('');
      try { await acquire(); await broker.current!.connect(nextSymbol.code, b => engine.current!.onBook(b), connectionStatus, () => { void engine.current!.sync().catch(e => setMessage(errorText(e))); }); await engine.current!.sync(); }
      catch (e) { setMessage(errorText(e)); connectionStatus('error'); }
      finally { setBusy(false); }
      return;
    }
    setBusy(true); setMessage(''); connectionStatus('connecting');
    let next: Broker | undefined;
    try {
      if (session.env === 'vps') throw new Error('KIS 모의계좌의 정정가능조회 지원은 미검증입니다. 현재 버전은 실전 어댑터만 연결합니다.');
      await acquire(); clearInterval(poll.current); broker.current?.disconnect(); setBook(undefined);
      next = new KisBroker(session.env);
      const tag = session.accountTag;
      const history = await sessions();
      const restored = history.find(s => s.kind === 'kis' && s.accountTag === tag && (s.entries.some(e => e.state !== 'done') || s.lots.some(l => l.state !== 'closed')));
      if (restored && restored.started < new Date().setHours(0, 0, 0, 0)) throw new Error('이전 날짜의 미종결 거래가 있습니다. HTS에서 잔고·주문을 대조해야 합니다. 이 PoC는 당일 주문만 복구합니다.');
      const restoredSymbol = restored?.lots.find(l => l.state !== 'closed')?.symbol || restored?.entries.find(e => e.state !== 'done')?.symbol;
      if (restoredSymbol && restoredSymbol !== nextSymbol.code) { const s = symbols.find(s => s.code === restoredSymbol) || { code: restoredSymbol, name: restoredSymbol }; setSelected(s); nextSymbol = s; }
      const instance = new TradingEngine(next, saveSnapshot, () => { if (engine.current === instance) { setSnapshot(structuredClone(instance.state)); setBook(liveConnection.current ? instance.book : undefined); } }, tag, restored);
      engine.current = instance; broker.current = next; setSnapshot(structuredClone(instance.state)); setSelected(nextSymbol);
      await next.connect(nextSymbol.code, b => instance.onBook(b), connectionStatus, () => { void instance.sync().catch(e => setMessage(errorText(e))); });
      await saveSnapshot(instance.state);
      if (next instanceof KisBroker) instance.log(next.fillDetail);
      poll.current = setInterval(() => { if (instance.exposed) void instance.sync().catch(e => setMessage(errorText(e))); }, 3000);
      if (restored) { instance.log('저장된 주문 상태 복원 · KIS 체결 내역 대조'); await instance.sync(); }
      if (next instanceof KisBroker) {
        const actual = await next.inventory(nextSymbol.code);
        if (actual.qty < instance.quantity) { for (const lot of instance.state.lots) if (lot.state !== 'closed') lot.state = 'unknown'; await saveSnapshot(instance.state); throw new Error('실제 잔고가 저장된 관리 수량보다 적습니다. 외부 거래 내역을 확인해 주세요.'); }
        instance.log(`계좌 잔고 대조: ${actual.qty}주 · 이 앱 관리 ${instance.quantity}주. 기존 보유분은 자동 편입하지 않습니다.`);
      }
    } catch (e) {
      setMessage(errorText(e)); connectionStatus('error');
      if (!engine.current?.exposed) { next?.disconnect(); release.current?.(); release.current = undefined; }
    } finally { setBusy(false); }
  }
  function connectionStatus(value: string) {
    liveConnection.current = value === 'connected';
    setStatus(value);
    setBook(value === 'connected' ? engine.current?.book : undefined);
  }
  function disconnect() {
    if (engine.current?.exposed) { exitDialog.current?.showModal(); return; }
    clearInterval(poll.current); broker.current?.disconnect(); release.current?.(); release.current = undefined; connectionStatus('idle'); exitDialog.current?.close();
  }
  async function buy() {
    if (!engine.current || !selected || !book || !connected || busy || stale) return;
    const validation = ruleSchema.safeParse(rule); if (!validation.success) { setMessage('익절·손절은 0보다 크게, 비용률은 0~5%로 설정해 주세요.'); return; }
    setBusy(true); setMessage('');
    try { await engine.current.buy(selected, quantity, rule); } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  async function closeAll() {
    if (!engine.current) return; setBusy(true); setMessage('');
    try { await engine.current.closeAll(); await engine.current.sync(); } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  async function handleUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setAuthError('');
    const element = event.currentTarget;
    const form = new FormData(element);
    try {
      const value = await unlockServer(String(form.get('password')));
      setSession(value); element.reset(); setMessage('화면 잠금을 해제했습니다. API 인증정보는 로컬 서버에서 관리합니다.');
    } catch (e) { setAuthError(errorText(e)); } finally { setBusy(false); }
  }
  function exportTrades() {
    const text = JSON.stringify({ exported: new Date().toISOString(), session: snapshot }, null, 2);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = 'click-trader-session.json'; a.click(); URL.revokeObjectURL(a.href);
  }
  async function handleLock() {
    try {
      if (engine.current?.exposed) { exitDialog.current?.showModal(); return; }
      await lockServer(); disconnect(); broker.current = null; engine.current = null; setSnapshot(undefined); setSession(undefined); setAuthError('');
    } catch (e) { setMessage(errorText(e)); }
  }
  function changeSymbol() {
    if (exposed || busy) return;
    disconnect(); broker.current = null; engine.current = null; setSnapshot(undefined); setSelected(undefined); setMessage('');
  }
  const maxQty = Math.max(1, ...(book?.asks.map(a => a.qty) || []), ...(book?.bids.map(b => b.qty) || []));
  const total = (book?.totalAsk || 0) + (book?.totalBid || 0);
  const stateText = status === 'idle' ? '연결 대기' : status === 'connected' ? 'KIS 연결됨' : status === 'connecting' ? '연결 중' : status === 'error' ? '연결 실패' : status === 'disconnected' ? '연결 끊김' : status;
  const pollingFills = !(broker.current instanceof KisBroker) || broker.current.fillMode === 'polling';
  const fillDetail = broker.current instanceof KisBroker ? broker.current.fillDetail : '체결 확인: REST 3초 간격 조회';

  if (!sessionChecked) return <SetupScreen step="loading" />;
  if (!session) return <SetupScreen step="lock"><LockForm busy={busy} disabled={!backendReady} error={authError} onSubmit={e => void handleUnlock(e)} /></SetupScreen>;
  if (!selected) return <SetupScreen step="symbol"><SymbolPicker onSelect={setSelected} /></SetupScreen>;

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="./"><span className="brand-mark"><Activity size={21} strokeWidth={2.2} /></span><span>click<span className="brand-light">trader</span><sup>POC</sup></span></a>
      <div className="top-actions"><span className="local-badge"><LockKeyhole size={13} /> 로컬 서버 연결</span><button className="button subtle key-button" disabled={busy || exposed} onClick={() => void handleLock()}><LockKeyhole size={16} />화면 잠금</button><button className="icon-button" aria-label="사용 안내" onClick={() => setHelp(!help)}><CircleHelp size={18} /></button></div>
    </header>
    <main>
      <section className="page-heading"><div><div className="eyebrow">YOUR ENTRY. YOUR RULES.</div><h1>진입은 직접, 청산은 규칙대로.</h1><p>호가를 보고 매수하세요. 익절과 손절은 설정한 규칙이 이어받습니다.</p></div><button className="button subtle end-button" onClick={() => exitDialog.current?.showModal()}><Power size={15} /> 거래 종료</button></section>
      {help && <section className="notice help"><ShieldCheck size={18} /><div><strong>이 화면이 열려 있는 동안 자동 청산이 동작합니다.</strong><p>로컬 Node.js 서버가 KIS REST·WebSocket을 중계합니다. API 인증정보와 화면 암호는 서버 환경변수에서만 읽습니다. 실현손익은 이 세션 거래와 설정한 비용률 기준 추정치입니다.</p><p>손절은 지정가 정정으로 실행되며 체결을 보장하지 않습니다. 탭 종료·절전·세션 만료·네트워크 단절 시 자동 손절 감시는 중단됩니다.</p></div><button className="icon-button" aria-label="안내 닫기" onClick={() => setHelp(false)}><X size={16} /></button></section>}
      <section className="connection-bar"><span className="pill">KIS {session.env === 'vps' ? '모의' : '실전'} · KRX</span><span className={`connection-state ${connected ? 'online' : ''}`}><i />{stateText}</span><span className="connection-caption">Node.js 중계 · 실제 호가</span><button className="button connection-button" disabled={busy} onClick={() => connected ? disconnect() : void connect()}>{connected ? <Unplug size={14} /> : <Radio size={14} />}{connected ? '연결 종료' : 'KIS 연결 시작'}</button></section>
      <p className="fill-status"><span>{fillDetail}</span>{pollingFills && <span>체결 확인과 익절 주문 등록에 조회 주기·통신 지연이 반영됩니다.</span>}</p>
      {message && <div className="notice message" role="status"><Activity size={16} /><span>{message}</span><button className="icon-button" aria-label="메시지 닫기" onClick={() => setMessage('')}><X size={15} /></button></div>}
      {stale && <div className="notice warning">호가 수신이 10초 이상 지연되었습니다. 신규 매수가 중지됩니다. 연결 상태를 확인해 주세요.</div>}
      <div className="workspace">
        <section className="card market-card">
          <div className="section-top"><span className="section-label">MARKET</span><span className="tiny-status"><i className={connected ? 'pulse-dot' : ''} />{book ? clock(book.time) : '시세 대기'}</span></div>
          <div className="stock-heading"><div className="stock-avatar">{selected.name.slice(0, 1)}</div><div className="stock-select"><button className="stock-picker-button" disabled={exposed || busy} onClick={changeSymbol} aria-label="종목 변경">{selected.name}<ChevronDown size={14} /></button><span>{selected.code} <span className="exchange-label">KRX</span></span></div><div className="stock-price"><strong>{book ? won(book.last || bid) : '—'}</strong><span>{book ? stale ? '원 · 마지막 수신 가격' : book.last ? '원 · 실시간 체결가' : '원 · 최우선 매수호가' : '실제 호가 수신 대기'}</span></div></div>
          <div className="book-head"><span>매도 잔량</span><span>호가 (원)</span><span>매수 잔량</span></div>
          <div className="orderbook" aria-label="10단계 호가창" ref={bookElement}>
            {book ? <>
              {[...book.asks].reverse().map((a, i) => <div className="book-row ask" key={`a${i}`}><div className="depth-cell"><span className="depth-bar" style={{ width: `${a.qty / maxQty * 100}%` }} /><span>{won(a.qty)}</span></div><strong>{won(a.price)}</strong><span /></div>)}
              <div className="spread"><span>스프레드</span><strong>{won(book.asks[0].price - book.bids[0].price)}원</strong><span>{stale ? 'STALE' : 'LIVE KRX'}</span></div>
              {book.bids.map((b, i) => <div className="book-row bid" key={`b${i}`}><span /><strong>{won(b.price)}</strong><div className="depth-cell"><span className="depth-bar" style={{ width: `${b.qty / maxQty * 100}%` }} /><span>{won(b.qty)}</span></div></div>)}
            </> : <div className="empty-book"><Radio size={30} strokeWidth={1.3} /><strong>실제 호가 수신 대기</strong><p>KIS 연결 후 수신한 가격과 잔량만 표시합니다.<br />연결되지 않으면 시세를 표시하지 않습니다.</p><button className="button subtle" disabled={busy} onClick={() => void connect()}>호가 연결 <ArrowRight size={14} /></button></div>}
          </div>
          <div className="book-total"><span className="ask-text">{book ? won(book.totalAsk) : '—'}</span><span>총 잔량</span><span className="bid-text">{book ? won(book.totalBid) : '—'}</span></div>{book && <div className="imbalance"><span style={{ width: `${total ? (book.totalAsk / total * 100) : 0}%` }} /></div>}
        </section>
        <div className="trading-column">
          <section className="card trade-card"><div className="section-top"><span className="section-label">QUICK BUY</span><span className="pill">최유리 지정가</span></div><h2>한 번의 클릭으로 진입</h2><p className="muted small">체결 즉시 익절 주문, 손절은 호가로 감시합니다.</p>
            <div className="field-title">매수 수량 <span>주</span></div><div className="quantity-control"><button aria-label="매수 수량 줄이기" disabled={quantity <= 1} onClick={() => setQuantity(Math.max(1, quantity - 1))}>−</button><input aria-label="매수 수량" type="number" min="1" max="100000" value={quantity} onChange={e => setQuantity(Math.min(100000, Math.max(1, Math.trunc(Number(e.target.value) || 1))))} /><button aria-label="매수 수량 늘리기" onClick={() => setQuantity(Math.min(100000, quantity + 1))}>+</button></div><div className="quantity-presets">{[1, 5, 10].map(n => <button key={n} className={quantity === n ? 'selected' : ''} onClick={() => setQuantity(n)}>{n}주</button>)}</div>
            <div className="rule-heading"><span className="field-title">자동 청산 규칙</span><div className="unit-tabs"><button className={rule.unit === 'won' ? 'active' : ''} onClick={() => setRule({ ...rule, unit: 'won', take: 500, stop: 300 })}>금액</button><button className={rule.unit === 'percent' ? 'active' : ''} onClick={() => setRule({ ...rule, unit: 'percent', take: 1, stop: .5 })}>비율</button></div></div>
            <div className="rule-inputs"><label><span><ArrowUpRight size={14} /> 익절</span><div><span className="sign">+</span><input aria-label="익절 기준" type="number" min="0.01" step={rule.unit === 'won' ? 100 : .1} value={rule.take} onChange={e => setRule({ ...rule, take: Number(e.target.value) })} /><span>{rule.unit === 'won' ? '원' : '%'}</span></div></label><label><span><ArrowDownRight size={14} /> 손절</span><div><span className="sign">−</span><input aria-label="손절 기준" type="number" min="0.01" step={rule.unit === 'won' ? 100 : .1} value={rule.stop} onChange={e => setRule({ ...rule, stop: Number(e.target.value) })} /><span>{rule.unit === 'won' ? '원' : '%'}</span></div></label></div>
            <p className="rule-note">실제 체결가 기준 · 금액은 1주당 가격 차이<br />기존 포지션의 규칙은 유지됩니다.</p>
            <div className="estimated"><span>예상 주문 금액</span><strong>{book ? `${won((book.asks[0]?.price || 0) * quantity)}원` : '—'}</strong></div>
            <button className="buy-button" disabled={!connected || !book || busy || stale || engine.current?.uncertain || !ruleSchema.safeParse(rule).success} onClick={() => void buy()}><span>{busy ? '처리 중…' : `${quantity}주 매수`}</span><ArrowRight size={20} /></button><p className="buy-caption">실제 계좌 주문 · 체결 가격은 호가에 따라 달라집니다</p>
          </section>
          <section className="card position-card"><div className="section-top"><span className="section-label">POSITION</span><span className={`pill ${quantityHeld ? 'green' : ''}`}><ShieldCheck size={12} />{quantityHeld ? '자동 청산 관리' : '진입 대기'}</span></div><div className="position-summary"><div><span className="muted small">이 앱 관리 수량</span><strong>{snapshot ? quantityHeld : '—'}<small>주</small></strong></div><div className="right"><span className="muted small">평가손익 · 비용 전</span><strong className={unrealized === undefined ? '' : unrealized >= 0 ? 'positive' : 'negative'}>{unrealized === undefined ? '—' : quantityHeld ? signed(unrealized) : '0'}<small>원</small></strong></div></div>
            {pending.map(e => <div className="pending-order" key={e.id}>{e.name} 매수 {e.filled}/{e.qty}주 · {e.state === 'unknown' || e.state === 'sending' ? '응답 확인 필요 · HTS 주문내역 대조' : '미체결 감시 중'}</div>)}
            {activeLots.length ? <div className="lot-list">{activeLots.map(l => <div className="lot" key={l.id}><div><strong>{l.name} {l.qty - l.sold}주</strong><span>{won(l.entry)}원 진입</span></div><div className="right"><strong className={l.state === 'unknown' ? 'negative' : ''}>{stateLabel[l.state]}</strong><span>익절 {won(l.target)} · 손절 {l.stop > 0 ? won(l.stop) : '청산 진행'}</span></div></div>)}</div> : <p className="position-empty">{pending.length ? '매수 체결을 기다리고 있습니다.' : '체결된 포지션이 여기에 표시됩니다.'}</p>}
            {exposed && <button className="button full subtle" disabled={busy || !connected} onClick={() => void closeAll()}>보유 수량 청산</button>}
          </section>
        </div>
        <section className="card performance-card"><div className="section-top"><span className="section-label">SESSION PERFORMANCE</span><span className="pill">실현손익 · 비용 추정 반영</span></div><div className="performance-heading"><div><p className="muted small">이번 세션 누적 실현손익</p><strong className={`pnl-number ${net > 0 ? 'positive' : net < 0 ? 'negative' : ''}`}>{signed(net)}<small>원</small></strong></div><div className="session-date">{new Date(now).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })}<span>{snapshot ? `${clock(snapshot.started)} 시작` : '세션 대기'}</span></div></div>
          {trades.length ? <Suspense fallback={<div className="pnl-chart" />}><PerformanceChart trades={trades} started={snapshot?.started || now} now={now} /></Suspense> : <div className="pnl-chart"><div className="chart-empty"><span>아직 실현손익 데이터가 없습니다.</span><strong>실제 매도 체결 후 차트가 표시됩니다.</strong></div></div>}
          <div className="metrics"><div><span>청산 체결</span><strong>{trades.length}<small>건</small></strong></div><div><span>승률 · 순손익 기준</span><strong>{trades.length ? Math.round(trades.filter(t => t.net > 0).length / trades.length * 100) : '—'}<small>{trades.length ? '%' : ''}</small></strong></div><div><span>추정 거래 비용</span><strong>{won(cost)}<small>원</small></strong></div></div>
          <div className="history-heading"><h3>체결 기록</h3><button className="text-button" onClick={exportTrades} disabled={!snapshot}>내보내기 <ArrowDown size={12} /></button></div>
          <div className="trade-history">{trades.length ? [...trades].reverse().map(t => <div className="trade-row" key={t.id}><span className={`trade-icon ${t.net >= 0 ? 'gain' : 'loss'}`}>{t.net >= 0 ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}</span><div><strong>{t.name} <span>{t.qty}주 · {t.reason}</span></strong><small>{clock(t.time)} · {won(t.entry)} → {won(t.exit)}</small></div><strong className={t.net >= 0 ? 'positive' : 'negative'}>{signed(t.net)}<small>원</small></strong></div>) : <div className="empty-history"><Check size={17} /><span>아직 청산된 거래가 없습니다.</span></div>}</div>
          <div className="cost-settings"><button className="text-button" onClick={() => setAdvanced(!advanced)}><Settings2 size={13} /> 비용률 설정 <ChevronDown size={12} /></button>{advanced && <div className="cost-fields">{([['buyFee', '매수 수수료'], ['sellFee', '매도 수수료'], ['tax', '매도 세금']] as const).map(([key, label]) => <label key={key}>{label} (%)<input type="number" min="0" max="5" step="0.001" value={rule[key]} onChange={e => setRule({ ...rule, [key]: Number(e.target.value) })} /></label>)}<p>예시 비용률입니다. 본인 계좌·종목에 맞게 수정해 주세요. 변경 후 매수부터 적용됩니다.</p></div>}</div>
        </section>
      </div>
      <section className="card activity-card"><div className="section-top"><span className="section-label">ACTIVITY</span><button className="text-button" disabled={!connected} onClick={() => void engine.current?.sync().catch(e => setMessage(errorText(e)))}>주문 상태 대조</button></div>{snapshot?.logs.length ? <div className="activity-list">{snapshot.logs.slice(0, 8).map(l => <div key={l.id} className={l.level === 'error' ? 'log-error' : ''}><time>{clock(l.time)}</time><span>{l.message}</span></div>)}</div> : <p className="muted small">연결·주문·자동 청산 이벤트가 여기에 기록됩니다.</p>}</section>
      <footer><span><ShieldCheck size={14} /> 인증정보는 서버 환경변수에서 관리합니다.</span><span>탭이 닫히면 자동 손절 감시도 중단됩니다.</span><a href="https://github.com/YoungjuneKwon/kis-click-trader" target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={12} /></a></footer>
    </main>
    <dialog ref={exitDialog} className="exit-dialog"><div className="popover-heading"><h2>거래를 마칠까요?</h2><button className="icon-button" aria-label="종료 창 닫기" onClick={() => exitDialog.current?.close()}><X size={18} /></button></div><p>{exposed ? `보유 ${quantityHeld}주 · 매수 확인 중 ${pending.length}건이 남아 있습니다. 화면을 닫으면 자동 손절 감시가 중단됩니다.` : '보유 수량과 미종결 주문이 없습니다. 연결을 종료할 수 있습니다.'}</p>{exposed && <p className="micro">미체결 매수·응답 불명확 주문은 HTS에서 확인·취소해 주세요. 청산 버튼은 체결된 보유 물량의 매도 주문만 정정합니다.</p>}<div className="dialog-actions"><button className="button subtle" onClick={() => exitDialog.current?.close()}>계속 거래</button>{exposed ? <button className="button primary" disabled={busy || !connected} onClick={() => void closeAll()}>보유 수량 청산</button> : <button className="button primary" onClick={disconnect}>연결 종료</button>}</div></dialog>
  </div>;
}
