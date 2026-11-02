import { useState, type FormEvent } from 'react';
import { Activity, ArrowRight, LockKeyhole, Search } from 'lucide-react';
import { symbols, type SymbolInfo } from './model';

export function SetupScreen({ step, children }: { step: 'loading' | 'keys' | 'symbol'; children?: React.ReactNode }) {
  return <main className="setup-screen">
    <a className="brand setup-brand" href="./"><span className="brand-mark"><Activity size={21} /></span><span>click<span className="brand-light">trader</span><sup>POC</sup></span></a>
    <section className="setup-window" role="dialog" aria-modal="true" aria-label={step === 'keys' ? '필수 계좌 키 입력' : step === 'symbol' ? '필수 종목 선택' : '설정 확인 중'}>
      <div className="setup-steps"><span className={step === 'keys' ? 'current' : ''}>01 계좌 키</span><i /><span className={step === 'symbol' ? 'current' : ''}>02 종목 선택</span></div>
      {children || <p className="muted" role="status">저장된 설정을 확인하고 있습니다.</p>}
    </section>
    <p className="setup-footer">입력을 완료한 뒤 거래 화면이 열립니다. 실제 KIS 시세만 표시합니다.</p>
  </main>;
}

type KeyFormProps = {
  stored: boolean; tab: 'new' | 'unlock'; onTab: (tab: 'new' | 'unlock') => void;
  busy: boolean; error: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDelete?: () => void; autoFocus?: boolean;
};
export function KeyForm({ stored, tab, onTab, busy, error, onSubmit, onDelete, autoFocus }: KeyFormProps) {
  return <>
    <p className="muted small">키는 외부 앱 서버에 저장하지 않습니다.<br />암호화한 뒤 이 브라우저의 IndexedDB에 보관합니다.</p>
    {stored && <div className="mode-tabs vault-tabs"><button className={tab === 'unlock' ? 'active' : ''} disabled={busy} onClick={() => onTab('unlock')}>잠금 해제</button><button className={tab === 'new' ? 'active' : ''} disabled={busy} onClick={() => onTab('new')}>새 키 입력</button></div>}
    <form onSubmit={onSubmit} autoComplete="off">
      {tab === 'new' && <>
        <label>App Key<input name="appKey" type="password" required autoComplete="off" autoFocus={autoFocus} placeholder="한국투자 App Key" /></label>
        <label>App Secret<input name="appSecret" type="password" required autoComplete="off" placeholder="한국투자 App Secret" /></label>
        <div className="form-columns"><label>계좌번호 앞 8자리<input name="cano" type="password" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} required /></label><label>상품코드<input name="product" defaultValue="01" inputMode="numeric" pattern="[0-9]{2}" maxLength={2} required /></label></div>
        <label>HTS ID<input name="htsId" required placeholder="계좌 체결통보 구독에 사용" /></label>
        <div className="form-columns"><label>환경<select name="env" defaultValue="prod"><option value="prod">실전</option><option value="vps">모의 · 자동 정정 미검증</option></select></label><label>연결 방식<select name="transport" defaultValue={import.meta.env.DEV ? 'relay' : 'direct'}><option value="direct">직접 연결</option><option value="relay">로컬 개발 릴레이</option></select></label></div>
      </>}
      <label>{tab === 'unlock' ? '잠금 해제 암호' : '키 저장 암호'}<input name="password" type="password" minLength={8} required autoComplete="off" autoFocus={autoFocus && tab === 'unlock'} placeholder="8자 이상 · 암호는 저장하지 않습니다" /></label>
      {error && <div className="notice warning" role="alert">{error}</div>}
      <p className="micro">{tab === 'new' ? '정적 호스팅의 KIS 직접 연결은 CORS·혼합 콘텐츠로 제한됩니다. 릴레이는 npm run dev에서만 제공됩니다.' : '저장 당시의 연결 방식과 계좌 설정을 불러옵니다.'}</p>
      <button className="button primary full" disabled={busy}><LockKeyhole size={15} />{busy ? '처리 중…' : tab === 'unlock' ? '잠금 해제' : '암호화하여 저장'}</button>
    </form>
    {stored && onDelete && <button className="text-button delete-key" disabled={busy} onClick={onDelete}>저장된 키 삭제</button>}
    <p className="micro">잠금 해제 후에는 이 페이지의 코드가 키를 사용합니다. 공유 기기에서는 사용 후 키를 삭제해 주세요.</p>
  </>;
}

export function SymbolPicker({ onSelect }: { onSelect: (symbol: SymbolInfo) => void }) {
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const filtered = symbols.filter(s => s.name.toLowerCase().includes(query.trim().toLowerCase()) || s.code.includes(query.trim()));
  function submit(event: FormEvent) {
    event.preventDefault(); const value = query.trim();
    const match = symbols.find(s => s.name === value || s.code === value);
    if (match) { onSelect(match); return; }
    if (/^\d{6}$/.test(value)) { onSelect({ code: value, name: value }); return; }
    setError('목록에서 종목을 선택하거나 종목코드 6자리를 입력해 주세요.');
  }
  return <>
    <span className="section-label">SELECT YOUR MARKET</span>
    <h2 id="symbol-picker-title">거래할 종목을 선택해 주세요.</h2>
    <p className="muted small">자동으로 선택되는 종목은 없습니다.<br />선택 후 KIS 연결을 시작하면 실제 호가를 받습니다.</p>
    <form className="symbol-search" onSubmit={submit}>
      <label htmlFor="symbol-query">종목명 또는 종목코드</label>
      <div><Search size={17} /><input id="symbol-query" autoFocus autoComplete="off" placeholder="예: 삼성전자 또는 005930" value={query} onChange={e => { setQuery(e.target.value); setError(''); }} maxLength={40} /><button className="icon-button" aria-label="입력한 종목 선택"><ArrowRight size={18} /></button></div>
      {error && <p className="micro" role="alert">{error}</p>}
    </form>
    <div className="symbol-options">{filtered.map(s => <button key={s.code} onClick={() => onSelect(s)}><span className="stock-avatar">{s.name.slice(0, 1)}</span><span><strong>{s.name}</strong><small>{s.code} · KRX</small></span><ArrowRight size={16} /></button>)}</div>
    {!filtered.length && <p className="micro">국내주식 6자리 코드를 입력하면 해당 종목을 선택할 수 있습니다. 유효한 종목인지는 KIS 연결 시 확인합니다.</p>}
  </>;
}
