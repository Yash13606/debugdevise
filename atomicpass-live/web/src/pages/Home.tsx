import { Ticket } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api';
import { useDebounced, useLoad, useOncePerSession, usePageTitle } from '../lib';
import { EmptyState, EventCard, EventCardSkeleton, Notice, Tabs, type EventCardData } from '../ui';

export default function Home() {
  usePageTitle('Events');
  const intro = useOncePerSession('ap_intro_home');
  const meta = useLoad(() => get<{ cities: string[]; categories: string[] }>('/meta'), []);
  const [city, setCity] = useState('');
  const [category, setCategory] = useState('');
  const [typed, setTyped] = useState('');
  const q = useDebounced(typed.trim(), 250);
  const filtered = !!(city || category || q);
  const list = useLoad(
    () => get<{ events: EventCardData[] }>(`/events?${new URLSearchParams({ ...(city && { city }), ...(category && { category }), ...(q && { q }) })}`),
    [city, category, q],
    5000,
  );
  const events = list.data?.events ?? [];
  const tabs = useMemo(() => [{ value: '', label: 'All' }, ...(meta.data?.categories ?? []).map((c) => ({ value: c, label: c }))], [meta.data]);
  const clear = () => {
    setCity('');
    setCategory('');
    setTyped('');
  };

  return (
    <>
      <section className={'hero' + (intro ? ' hero--intro' : '')} aria-labelledby="hero-title">
        <h1 id="hero-title" className="hero__title">
          <span className="hero__line"><span style={{ ['--i' as string]: 0 }}>Get the ticket.</span></span>
          <span className="hero__line"><span style={{ ['--i' as string]: 1 }}>Not the scramble.</span></span>
        </h1>
        <div className="hero__aside">
          <p className="lede">Seats are held while you pay, released if you do not, and never sold twice.</p>
          <form className="search" role="search" onSubmit={(e) => e.preventDefault()}>
            <div>
              <label className="sr-only" htmlFor="q">Search events or venues</label>
              <input id="q" className="input" type="search" placeholder="Search events or venues" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <label className="sr-only" htmlFor="city">City</label>
              <select id="city" className="select" value={city} onChange={(e) => setCity(e.target.value)}>
                <option value="">All cities</option>
                {meta.data?.cities.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
          </form>
        </div>
      </section>

      <Tabs items={tabs} value={category} onChange={setCategory} label="Category" />

      <section aria-labelledby="results-title">
        <h2 id="results-title" className="sr-only">Upcoming events</h2>
        <div className="results-bar">
          <span className="mono" aria-live="polite">{list.data ? `${events.length} event${events.length === 1 ? '' : 's'}` : ' '}</span>
          {filtered && <button className="btn btn--ghost btn--sm" onClick={clear}>Clear filters</button>}
        </div>

        {list.error && !list.data ? (
          <Notice>The events could not be loaded. Check your connection, then <button className="linkbtn" onClick={() => void list.reload()}>try again</button>.</Notice>
        ) : !list.data ? (
          <div className="results" aria-busy="true">
            <EventCardSkeleton lead />
            <EventCardSkeleton />
            <EventCardSkeleton />
          </div>
        ) : events.length === 0 ? (
          <EmptyState icon={<Ticket size={32} weight="light" aria-hidden />} title={filtered ? 'No events match' : 'No events on sale yet'} action={filtered ? <button className="btn" onClick={clear}>Clear filters</button> : <Link className="btn" to="/organiser">List an event</Link>}>
            {filtered ? 'Try another city or category, or search for something broader.' : 'When an organiser publishes one, it appears here.'}
          </EmptyState>
        ) : (
          <div className="results">
            {events.map((e, i) => <EventCard key={e.id} e={e} lead={i === 0 && !filtered && events.length >= 3} />)}
          </div>
        )}
      </section>

      <section className="sect fair" aria-labelledby="fair-title">
        <div>
          <h2 id="fair-title">Fair when everyone clicks at once.</h2>
          <p className="lede" style={{ marginTop: 20 }}>Big sales open a waiting room, so the page never freezes and nobody can jump the line.</p>
        </div>
        <ul className="fair__list">
          <li className="fair__item"><h3>Held while you pay</h3><p>Choose your tickets and you have ten minutes. If you do not pay, the seats go back on sale.</p></li>
          <li className="fair__item"><h3>Never sold twice</h3><p>Each seat is taken in one step that either completes or does nothing. Two people tapping the last one cannot both win.</p></li>
          <li className="fair__item"><h3>One scan, one entry</h3><p>Every ticket carries a signed code. The gate can check it without a network, and it works once.</p></li>
        </ul>
      </section>

      <section className="sect band" aria-labelledby="host-title">
        <div className="split">
          <div>
            <h2 id="host-title" style={{ fontSize: 'clamp(30px, 4vw, 44px)' }}>Selling tickets yourself?</h2>
            <p className="lede" style={{ marginTop: 16 }}>Create an event, switch on a waiting room for the big rush, and watch every count audited live.</p>
          </div>
          <div className="row" style={{ justifyContent: 'flex-start' }}>
            <Link className="btn btn--lg" to="/organiser">List your event</Link>
          </div>
        </div>
      </section>
    </>
  );
}
