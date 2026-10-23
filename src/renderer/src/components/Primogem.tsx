import gem from '../assets/primogem.png';
export default function Primogem({ className = '', sparkle = false, decorative = true }: { className?: string; sparkle?: boolean; decorative?: boolean }) {
  return <span className={'gw-primogem ' + (sparkle ? 'gw-primogem-sparkle ' : '') + className}
    role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : '原石'} aria-hidden={decorative ? true : undefined}>
    <img src={gem} alt="" draggable={false} />
  </span>;
}
