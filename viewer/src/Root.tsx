import { useState } from 'react';
import { App } from './App';
import { Setup, useSetupState } from './Setup';

/** First launch when the folder has no spider.json yet; the app otherwise. */
export function Root() {
    const { state, error } = useSetupState();
    const [done, setDone] = useState(false);
    if (error) return <div className="empty">Couldn't reach the spider-web server: {error}</div>;
    if (!state) return null;
    if (!state.configured && !done) return <Setup initial={state} onDone={() => setDone(true)} />;
    return <App />;
}
