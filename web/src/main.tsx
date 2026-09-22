import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './auth';
import { ThemeProvider } from './components/theme';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
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
import './styles/interviewers.css';
import './styles/polish.css';
import './styles/tour.css';
import './styles/observer.css';
import './styles/catalogReview.css';
import './styles/library.css';
import './styles/room.css';
import './styles/scorecard.css';
import './styles/review.css';
import './styles/lists.css';
import './styles/hrbox.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* The last line of defence: a fault in the shell itself (auth, theme,
        router) still leaves a way out instead of a blank page. */}
    <ErrorBoundary scope="app">
      <BrowserRouter>
        <ThemeProvider>
          <AuthProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </AuthProvider>
        </ThemeProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
