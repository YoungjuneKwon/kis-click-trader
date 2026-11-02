import { useState, type FormEvent } from 'react';
import { Activity, ArrowRight, LockKeyhole, Search } from 'lucide-react';
import { symbols, type SymbolInfo } from './model';

export function SetupScreen({ step, children }: { step: 'loading' | 'lock' | 'symbol'; children?: React.ReactNode }) {
  return <main className="setup-screen">
    <a className="brand setup-brand" href="./"><span className="brand-mark"><Activity size={21} /></span><span>click<span className="brand-light">trader</span><sup>POC</sup></span></a>
    <section className="setup-window" role="dialog" aria-modal="true" aria-label={step === 'lock' ? '화면 잠금 인증' : step === 'symbol' ? '필수 종목 선택' : '서버 연결 확인 중'}>
      <div className="setup-steps"><span className={step === 'lock' ? 'current' : ''}>01 화면 잠금</span><i /><span className={step === 'symbol' ? 'current' : ''}>02 종목 선택</span></div>
      {children || <p className="muted" role="status">로컬 서버의 인증 상태를 확인하고 있습니다.</p>}
    </section>
    <p className="setup-footer">API 인증정보는 서버 환경변수에서만 읽습니다. 실제 KIS 시세만 표시합니다.</p>
  </main>;
}
export function LockForm({ busy, disabled, error, onSubmit }: { busy: boolean; disabled: boolean; error: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <>
    <span className="section-label">PRIVATE TRADING DESK</span>
    <h2>화면 잠금을 해제해 주세요.</h2>
    <p className="muted small">서버에 설정한 화면 잠금 암호를 입력해 주세요.<br />API 키·시크릿·계좌정보는 입력하지 않습니다.</p>
    <form onSubmit={onSubmit} autoComplete="off">
      <label>화면 잠금 암호<input name="password" type="password" required disabled={disabled || busy} maxLength={1024} autoComplete="current-password" autoFocus placeholder="서버 환경변수 CT_PW에 설정한 암호" /></label>
      {error && <div className="notice warning" role="alert">{error}</div>}
      <button className="button primary full" disabled={disabled || busy}><LockKeyhole size={15} />{busy ? '인증 중…' : '잠금 해제'}</button>
    </form>
    <p className="micro">암호는 서버에서 확인하며 브라우저 저장소에는 보관하지 않습니다.</p>
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
    <span className="section-label">SELECT YOUR MARKET</span><h2>거래할 종목을 선택해 주세요.</h2>
    <p className="muted small">자동으로 선택되는 종목은 없습니다.<br />선택 후 로컬 서버를 통해 실제 KIS 호가를 받습니다.</p>
    <form className="symbol-search" onSubmit={submit}>
      <label htmlFor="symbol-query">종목명 또는 종목코드</label>
      <div><Search size={17} /><input id="symbol-query" autoFocus autoComplete="off" placeholder="예: 삼성전자 또는 005930" value={query} onChange={e => { setQuery(e.target.value); setError(''); }} maxLength={40} /><button className="icon-button" aria-label="입력한 종목 선택"><ArrowRight size={18} /></button></div>
      {error && <p className="micro" role="alert">{error}</p>}
    </form>
    <div className="symbol-options">{filtered.map(s => <button key={s.code} onClick={() => onSelect(s)}><span className="stock-avatar">{s.name.slice(0, 1)}</span><span><strong>{s.name}</strong><small>{s.code} · KRX</small></span><ArrowRight size={16} /></button>)}</div>
    {!filtered.length && <p className="micro">국내주식 6자리 코드를 입력하면 해당 종목을 선택할 수 있습니다. 유효한 종목인지는 KIS 연결 시 확인합니다.</p>}
  </>;
}
