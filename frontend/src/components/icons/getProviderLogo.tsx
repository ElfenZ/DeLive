import {
  AssemblyAILogo,
  CloudflareLogo,
  DeepgramLogo,
  ElevenLabsLogo,
  GladiaLogo,
  GroqLogo,
  MistralLogo,
  OpenAILogo,
  SiliconFlowLogo,
  SonioxLogo,
  VolcengineLogo,
  WhisperCppLogo,
} from './ProviderLogos'

type AnyLogoProps = { size?: number; className?: string }

const PROVIDER_LOGO_MAP: Record<string, (props: AnyLogoProps) => JSX.Element> = {
  soniox: SonioxLogo,
  volc: VolcengineLogo,
  groq: GroqLogo,
  siliconflow: SiliconFlowLogo,
  mistral: MistralLogo,
  deepgram: DeepgramLogo,
  assemblyai: AssemblyAILogo,
  elevenlabs: ElevenLabsLogo,
  gladia: GladiaLogo,
  cloudflare: CloudflareLogo,
  local_openai: OpenAILogo,
  local_whisper_cpp: WhisperCppLogo,
}

export function getProviderLogo(
  providerId: string,
  size = 20,
  className?: string
): JSX.Element | null {
  const Logo = PROVIDER_LOGO_MAP[providerId]
  if (!Logo) return null
  return <Logo size={size} className={className} />
}
