import { useEffect, useState } from 'react';
import type { CharacterPortrait } from '../../../shared/models';
import { localImage } from '../lib/assets';
import { useTraveler } from './TravelerProvider';
import { isTravelerSpeaker } from '../../../shared/traveler';

export default function ReviewPortrait({ portrait }: { portrait: CharacterPortrait | null }) {
  const traveler = useTraveler();
  const selectedProtagonist = portrait?.traveler || isTravelerSpeaker(portrait?.name);
  const [loaded, setLoaded] = useState<{ path: string; url: string | null } | null>(null);
  const path = selectedProtagonist ? undefined : portrait?.imagePath;
  useEffect(() => {
    let active = true;
    if (path) void localImage(path).then(
      url => { if (active) setLoaded({ path, url }); },
      () => { if (active) setLoaded({ path, url: null }); },
    );
    return () => { active = false; };
  }, [path]);
  const url = path && loaded?.path === path ? loaded.url : null;
  const isCompanion = !url;
  const name = isCompanion ? traveler.name : portrait!.name;
  return (
    <div className="gw-art-stage" aria-label="角色立绘">
      <img
        src={url || traveler.portrait}
        alt={name + (isCompanion ? '伴读立绘' : '角色立绘')}
        className="gw-review-art"
        data-portrait-path={isCompanion ? 'bundled/' + traveler.choice + '-companion.webp' : path}
        onError={() => { if (path && url) setLoaded({ path, url: null }); }}
      />
      <div className="gw-art-caption">
        <span className="gw-portrait-name">{name}</span>
        <span className="gw-muted">{isCompanion ? '与你一起记住这一页' : '提瓦特 · 同行者'}</span>
      </div>
    </div>
  );
}
