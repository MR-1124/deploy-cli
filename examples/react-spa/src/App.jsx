import { Link, Route, Routes, useLocation } from "react-router-dom";

function Home() {
  return (
    <section>
      <h1>Home</h1>
      <p>
        This app uses <code>BrowserRouter</code>, so deep links like
        <a href="/about"> /about</a> are resolved by the <em>server</em>.
        Reload any route — the local control plane's SPA fallback serves
        <code> index.html</code> and React Router takes over.
      </p>
    </section>
  );
}

function About() {
  return (
    <section>
      <h1>About</h1>
      <p>Loaded via the deep link <code>/about</code>.</p>
    </section>
  );
}

function Contact() {
  return (
    <section>
      <h1>Contact</h1>
      <p>Loaded via the nested deep link <code>/team/contact</code>.</p>
    </section>
  );
}

export default function App() {
  const { pathname } = useLocation();
  return (
    <div>
      <nav>
        <Link to="/">Home</Link>
        {" · "}
        <Link to="/about">About</Link>
        {" · "}
        <Link to="/team/contact">Contact</Link>
      </nav>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
        <Route path="/team/contact" element={<Contact />} />
        <Route
          path="*"
          element={
            <section>
              <h1>404</h1>
              <p>No client-side route for <code>{pathname}</code>.</p>
            </section>
          }
        />
      </Routes>
    </div>
  );
}
