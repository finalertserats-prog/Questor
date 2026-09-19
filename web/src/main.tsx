import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './auth';
import { ThemeProvider } from './components/theme';
import { App } from './App';
import './styles/app.css';
import './styles/sidebar.css';
import './styles/workflow.css';
import './styles/login.css';
import './styles/signup.css';
import './styles/about.css';
import './styles/pipeline.css';
import './styles/journey.css';
import './styles/dashboard.css';
import './styles/health.css';
import './styles/polish.css';
import './styles/tour.css';
import './styles/observer.css';
import './styles/catalogReview.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
