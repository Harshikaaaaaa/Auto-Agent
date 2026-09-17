import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// react-flow's base stylesheet, imported before our own CSS so the overrides in
// index.css (handles, controls, edges) win. This used to be a
// `https://cdn.jsdelivr.net` <link> in index.html; bundling it lets the CSP
// drop that CDN origin.
import 'reactflow/dist/style.css';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
