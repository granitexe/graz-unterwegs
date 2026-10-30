export function Icon({ name }: { name: string }) {
  const url = `${import.meta.env.BASE_URL}icons/${name}.svg`
  return <span aria-hidden="true" className="icon" style={{ maskImage: `url("${url}")`, WebkitMaskImage: `url("${url}")` }} />
}
