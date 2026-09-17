import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { modelLabel } from '@/lib/modelCatalog';

/**
 * A model as a person knows it: the maker's mark and the model's name.
 *
 * The composer said "openrouter · meta/muse-spark-1.3-contributor", which is an
 * address. The name comes from the OpenRouter catalog when it is cached (and a
 * readable guess from the id when it is not); the mark is the company that made
 * the model, because that is what people recognise. The route (OpenRouter,
 * Ollama) moves to the tooltip.
 *
 * A model with no maker in its id and no known provider is a local file, and
 * local weights come from Hugging Face, so it gets that mark. A maker the logo
 * set does not have gets its initial rather than a wrong logo.
 *
 * The marks live in `modelLogoData.ts` (generated from @lobehub/icons-static-svg,
 * MIT) and load on first use.
 */

type LogoData = typeof import('./modelLogoData');
let data: LogoData | null = null;
let loading: Promise<LogoData> | null = null;
function loadLogos(): Promise<LogoData> {
  loading ??= import('./modelLogoData').then((m) => (data = m));
  return loading;
}

/** Names for routes, which the logo set titles well ("openrouter" becomes "OpenRouter"). */
const ROUTE_NAMES: Record<string, string> = {
  openrouter: 'OpenRouter', ollama: 'Ollama', lmstudio: 'LM Studio', groq: 'Groq',
  together: 'Together AI', fireworks: 'Fireworks', deepinfra: 'DeepInfra', anthropic: 'Anthropic',
  openai: 'OpenAI', google: 'Google', mistral: 'Mistral', azure: 'Azure', bedrock: 'Bedrock',
  local: 'this computer',
};

/** The maker segment of a model id ("meta/muse-spark" gives "meta"), else the provider. */
export function makerOf(modelId: string | undefined, provider?: string): string | null {
  const id = (modelId ?? '').replace(/^~/, '');
  const slash = id.indexOf('/');
  if (slash > 0) return id.slice(0, slash).toLowerCase();
  return provider ? provider.toLowerCase() : null;
}

/** "Meta: Muse Spark 1.3 Contributor" from the catalog reads as "Muse Spark 1.3 Contributor": the mark says Meta. */
export function modelDisplayName(modelId: string | undefined): string {
  return modelLabel(modelId).replace(/^[^:]{1,40}:\s+/, '');
}

/** How a route is named to a person. */
export function providerName(provider: string | undefined): string {
  const key = (provider ?? '').toLowerCase();
  return ROUTE_NAMES[key] ?? provider ?? '';
}

/**
 * Which logo to show: the maker's, Hugging Face for a local file, or null when
 * the maker is named but has no mark (the caller shows its initial).
 */
export function logoKeyFor(modelId: string | undefined, provider: string | undefined, table: Record<string, string>): string | null {
  const maker = makerOf(modelId, provider);
  if (maker && table[maker]) return table[maker];
  const hasMaker = (modelId ?? '').includes('/');
  return hasMaker ? null : 'huggingface';
}

export function ModelLogo({ modelId, provider, className }: { modelId?: string; provider?: string; className?: string }) {
  const [logos, setLogos] = useState<LogoData | null>(data);
  useEffect(() => {
    if (logos) return;
    let alive = true;
    void loadLogos().then((m) => alive && setLogos(m));
    return () => {
      alive = false;
    };
  }, [logos]);

  if (!modelId && !provider) return null;
  // Same footprint while the marks load, so the name beside it does not jump.
  if (!logos) return <span aria-hidden className={cn('inline-block size-3.5 shrink-0', className)} />;

  const key = logoKeyFor(modelId, provider, logos.MAKER_TO_LOGO);
  const logo = key ? logos.LOGOS[key] : undefined;
  if (!logo) {
    const maker = makerOf(modelId, provider) ?? '?';
    return (
      <span
        aria-hidden
        className={cn('inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm bg-bg-hover text-micro font-semibold uppercase', className)}
      >
        {maker.charAt(0)}
      </span>
    );
  }
  return (
    <svg
      viewBox={logo.viewBox}
      aria-hidden
      fillRule="evenodd"
      className={cn('size-3.5 shrink-0 fill-current', className)}
      // Our own vendored constants, generated from a pinned package; never
      // model output or anything fetched at runtime.
      dangerouslySetInnerHTML={{ __html: `<title>${logo.title}</title>${logo.body}` }}
    />
  );
}
