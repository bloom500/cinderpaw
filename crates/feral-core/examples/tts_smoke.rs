//! Manual smoke test: `FISH_API_KEY=... cargo run -p feral-core --example tts_smoke`
//! Writes out.pcm. Not a unit test — it costs a real API call.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let key = std::env::var("FISH_API_KEY").expect("set FISH_API_KEY");
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    let text = "Feral here. Voice mode is working.";

    let started = std::time::Instant::now();
    let mut first_chunk_at = None;
    let collector = tokio::spawn(async move {
        let mut all = Vec::new();
        let mut chunks = 0usize;
        while let Some(c) = rx.recv().await {
            chunks += 1;
            all.extend_from_slice(&c);
        }
        (all, chunks)
    });

    let total = feral_core::tts::synthesize(&key, text, &Default::default(), tx).await?;
    let (audio, chunks) = collector.await?;
    first_chunk_at.get_or_insert(started.elapsed());

    println!("bytes returned : {total}");
    println!("bytes collected: {}", audio.len());
    println!("chunks         : {chunks}  (>1 means it really streamed)");
    println!("duration       : {:.2}s audio", audio.len() as f64 / 48_000.0);
    println!("wall clock     : {:.2}s", started.elapsed().as_secs_f64());
    std::fs::write("out.pcm", &audio)?;
    Ok(())
}
