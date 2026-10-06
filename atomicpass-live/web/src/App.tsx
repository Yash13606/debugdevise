import { List, SignOut, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { useRouteFocus } from './lib';
import Checkout from './pages/Checkout';
import EventPage from './pages/EventPage';
import Gate from './pages/Gate';
import Home from './pages/Home';
import Inbox from './pages/Inbox';
import Login from './pages/Login';
import Organiser from './pages/Organiser';
import OrganiserEvent from './pages/OrganiserEvent';
import Tickets from './pages/Tickets';
import { EmptyState } from './ui';

const STRIP_KEY = 'ap_strip_dismissed';
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

export default function App() {
  const { user, ready, signOut } = useAuth();
  const here = useLocation().pathname;
  const main = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState(false);
  const [strip, setStrip] = useState(() => !read(STRIP_KEY));
  useRouteFocus(main);
  useEffect(() => setMenu(false), [here]);

  const links = [
    { to: '/', label: 'Events' },
    ...(user ? [{ to: '/tickets', label: 'My tickets' }, { to: '/inbox', label: 'Messages' }, { to: '/organiser', label: 'Organiser' }, { to: '/gate', label: 'Gate' }] : []),
  ];
  const nav = links.map((l) => (
    <NavLink key={l.to} to={l.to} end={l.to === '/'}>
      {l.label}
    </NavLink>
  ));

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      {strip && (
        <div className="strip" role="region" aria-label="Demo notice">
          <div className="wrap strip__in">
            <span>Demo build. Payments are simulated and login codes appear on screen. No real money moves.</span>
            <button
              className="strip__x"
              aria-label="Dismiss this notice"
              onClick={() => {
                setStrip(false);
                try {
                  localStorage.setItem(STRIP_KEY, '1');
                } catch {
                  // storage blocked: it will show again next visit
                }
              }}
            >
              <X size={16} weight="light" aria-hidden />
            </button>
          </div>
        </div>
      )}
      <header className="site-header">
        <div className="wrap site-header__bar">
          <Link to="/" className="brand">
            <span className="brand__mark" aria-hidden />
            AtomicPass
          </Link>
          <nav className="nav" aria-label="Main">{nav}</nav>
          <div className="site-header__right">
            {ready && user ? (
              <>
                <span className="small graphite">{user.name || user.phone}</span>
                <button className="btn btn--outline btn--sm" onClick={signOut}>Sign out</button>
              </>
            ) : (
              ready && <Link className="btn btn--sm" to="/login" state={{ from: here }}>Sign in</Link>
            )}
          </div>
          <button className="menu-btn" aria-expanded={menu} aria-controls="mobile-nav" onClick={() => setMenu(!menu)}>
            {menu ? <X size={20} weight="light" aria-hidden /> : <List size={20} weight="light" aria-hidden />}
            Menu
          </button>
        </div>
        <nav id="mobile-nav" className="mobile-nav" aria-label="Main" data-open={menu || undefined} {...(!menu ? { inert: '' } : {})}>
          {nav}
          {ready && user ? (
            <button className="btn btn--outline" onClick={signOut}>
              <SignOut size={18} weight="light" aria-hidden /> Sign out {user.name ? `(${user.name.split(' ')[0]})` : ''}
            </button>
          ) : (
            ready && <Link className="btn" to="/login" state={{ from: here }}>Sign in</Link>
          )}
        </nav>
      </header>
      <main className="wrap" id="main" tabIndex={-1} ref={main}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/e/:id" element={<EventPage />} />
          <Route path="/checkout/:holdId" element={<Checkout />} />
          <Route path="/tickets" element={<Tickets />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/organiser" element={<Organiser />} />
          <Route path="/organiser/:id" element={<OrganiserEvent />} />
          <Route path="/gate" element={<Gate />} />
          <Route
            path="*"
            element={<EmptyState title="That page does not exist" action={<Link className="btn" to="/">Back to events</Link>}>The link may be old, or mistyped.</EmptyState>}
          />
        </Routes>
      </main>
      <footer className="foot">
        <div className="wrap">AtomicPass Live is a prototype built after the hackathon submission. The backend and tests are real; payments are simulated.</div>
      </footer>
    </>
  );
}
