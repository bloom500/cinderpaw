interface Props { title: string; message: string }
export function StubPage({ title, message }: Props) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-text-muted">
      <h1 className="text-2xl text-text-secondary mb-2">{title}</h1>
      <p>{message}</p>
    </div>
  );
}
