import { ArrowRight, ShieldCheck } from 'lucide-react';
import { clock, signed, won, type Book, type Entry, type Snapshot } from './model';
import { summarizeEntry } from './entry-summary';

type Props = { snapshot?: Snapshot; book?: Book; now: number; busy: boolean; connected: boolean; closingId?: string; onClose: (id: string) => void };
export default function EntryHistory({ snapshot, book, now, busy, connected, closingId, onClose }: Props) {
  const entries = snapshot?.entries || [];
  const isOpen = (entry: Entry) => entry.state !== 'done' || snapshot!.lots.some(l => l.entryId === entry.id && l.state !== 'closed');
  const active = entries.filter(isOpen).reverse();
  const archive = entries.filter(entry => !isOpen(entry)).reverse();
  const renderEntry = (entry: Entry) => {
        const view = summarizeEntry(snapshot!, entry, book, now);
        const number = entries.indexOf(entry) + 1;
        const closing = entry.closeRequested && !view.completed;
        const guardedLots = view.lots.filter(lot => lot.sold < lot.qty && lot.reason === '익절');
        const priceRange = (values: number[]) => {
          const min = Math.min(...values), max = Math.max(...values);
          return min === max ? won(min) : `${won(min)}–${won(max)}`;
        };
        return <article className="entry-row" key={entry.id} aria-label={`진입 ${number} ${entry.name}`}>
          <header><div className="entry-title"><span className="entry-number">#{String(number).padStart(3, '0')}</span><strong>{entry.name}</strong><span className={`pill ${view.completed ? '' : view.uncertain ? 'entry-alert' : 'green'}`}>{view.status}</span><small>{view.createdAt ? clock(view.createdAt) : '시각 미확인'}{entry.ref ? ` · 주문 ${entry.ref.id}` : ''}</small></div>
            <button className="button entry-close-button" disabled={busy || !connected || !view.canClose || !book || now - book.time > 10000} onClick={() => onClose(entry.id)} aria-label={`진입 ${number} 즉시 청산`}>
              {closingId === entry.id || closing ? '청산 요청 중' : view.completed ? '청산 완료' : '즉시 청산'}{!view.completed && <ArrowRight size={13} />}
            </button>
          </header>
          {guardedLots.length > 0 && <div className="entry-rule-prices"><span>익절 예약 {priceRange(guardedLots.map(lot => lot.target))}원</span><span>손절 감시 {priceRange(guardedLots.map(lot => lot.stop))}원</span></div>}
          <div className="entry-values">
            <div><span>매수 체결 / 주문</span><strong>{entry.filled} / {entry.qty}<small>주</small></strong></div>
            <div><span>미체결 매수</span><strong>{view.pending}<small>주</small></strong></div>
            <div><span>미청산 / 청산</span><strong>{view.remaining} / {view.sold}<small>주</small></strong></div>
            <div><span>평균 진입가</span><strong>{view.averageEntry === undefined ? '—' : won(view.averageEntry)}<small>원</small></strong></div>
            <div><span>평균 청산가</span><strong>{view.averageExit === undefined ? '—' : won(view.averageExit)}<small>원</small></strong></div>
            <div><span>실현손익 · 비용 차감</span><strong className={view.net >= 0 ? 'positive' : 'negative'}>{signed(view.net)}<small>원</small></strong></div>
            <div><span>미실현손익 · 비용 전</span><strong className={view.unrealized === undefined ? '' : view.unrealized >= 0 ? 'positive' : 'negative'}>{view.unrealized === undefined ? '—' : signed(view.unrealized)}<small>원</small></strong></div>
          </div>
          {view.updating && <p className="entry-row-note">익절 매도 정정 결과를 확인하고 있습니다. 변경된 손절 기준도 이 진입건에 저장했습니다.</p>}
          {view.uncertain && !view.updating && <p className="entry-row-note">주문 상태 확인이 필요합니다. 중복 주문을 막기 위해 즉시 청산을 비활성화했습니다.</p>}
          {closing && view.pending > 0 && <p className="entry-row-note">미체결 매수 취소를 확인 중입니다. 취소 전 추가 체결분도 이 진입건에 포함하여 청산합니다.</p>}
        </article>;
      };
  return <section className="card entry-history" aria-label="이 화면의 진입 내역">
    <div className="entry-history-heading"><div><span className="section-label">MY ENTRIES</span><h2>진입 내역 <span>미종결 {active.length}건</span></h2></div><span className="entry-scope"><ShieldCheck size={13} />기존 보유분 제외</span></div>
    <p className="entry-history-note">즉시 청산은 해당 진입건의 미체결 매수를 취소하고, 체결된 잔여 수량만 처리합니다.</p>
    {active.length ? <div className="entry-rows">{active.map(renderEntry)}</div> : <div className="entry-history-empty">현재 미청산·미종결 진입건이 없습니다.</div>}
    {archive.length > 0 && <details className="entry-archive"><summary>완료·종료된 진입 {archive.length}건 <span>보기</span></summary><div className="entry-rows">{archive.map(renderEntry)}</div></details>}
    <p className="entry-calculation-note">손익 = 이 진입건의 매도 체결금액 − 해당 매수 원가 − 설정한 추정 비용. KIS 계좌 평균매입가·평가손익은 사용하지 않습니다.</p>
  </section>;
}
