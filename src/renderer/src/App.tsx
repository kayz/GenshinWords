import { Route, Routes, HashRouter, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import Review from './pages/Review';
import Practice from './pages/Practice';
import Reading from './pages/Reading';
import Rewards from './pages/Rewards';
import Browse from './pages/Browse';
import About from './pages/About';
import Collection from './pages/Collection';
import Content from './pages/Content';
import Layout from './components/Layout';
import TravelerProvider from './components/TravelerProvider';

export default function App() {
  return (
    <HashRouter>
      <TravelerProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index={true} element={<Home />} />
          <Route path="review" element={<Review />} />
          <Route path="practice" element={<Practice />} />
          <Route path="reading" element={<Reading />} />
          <Route path="rewards" element={<Rewards />} />
          <Route path="browse" element={<Browse />} />
          <Route path="collection" element={<Collection />} />
          <Route path="content" element={<Content />} />
          <Route path="about" element={<About />} />
          <Route path="*" element={<Navigate to="/" replace={true} />} />
        </Route>
      </Routes>
      </TravelerProvider>
    </HashRouter>
  );
}
