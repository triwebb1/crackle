export interface RoastReferenceBand {
  id: string
  minimumC: number
  maximumC?: number
  title: string
  kind: 'physical' | 'chemistry' | 'milestone' | 'risk'
  visual: string
  process: string
  timeEffect: string
  cupDirection: string
}

export interface RoastColorStop {
  temperatureC: number
  name: string
  color: string
  cue: string
}

export interface RoastStyleReference {
  id: string
  names: string
  family: string
  minimumC: number
  maximumC?: number
  colorName: string
  color: string
  landmark: string
}

export const roastReferenceBands: RoastReferenceBand[] = [
  {
    id: 'drying',
    minimumC: 100,
    maximumC: 150,
    title: 'Water loss and yellowing',
    kind: 'physical',
    visual: 'Green fades through pale straw into yellow; grassy steam gives way to cereal aromas.',
    process:
      'Free water evaporates and the bean becomes ready for faster browning chemistry. This is a physical phase, not a single flavor reaction.',
    timeEffect:
      'More time can improve internal evenness, but a weak, drawn-out approach delays later chemistry and can mute the cup. Excess speed can leave the center behind the surface.',
    cupDirection: 'Sets uniformity and reaction readiness more than a direct flavor target.',
  },
  {
    id: 'maillard',
    minimumC: 140,
    maximumC: 165,
    title: 'Maillard reactions accelerate',
    kind: 'chemistry',
    visual: 'Yellow shifts to tan and light brown; bread, malt, toast, and nut aromas emerge.',
    process:
      'Reducing sugars react with amino compounds, producing aroma intermediates and brown melanoidins. The band overlaps drying and sugar degradation.',
    timeEffect:
      'More useful time generally builds browned, nutty, cocoa, and body-associated character. Too much relative time can trade away brightness and distinct origin character.',
    cupDirection:
      'Longer tends toward rounder, maltier, nuttier cups; shorter tends to preserve more brightness if the roast remains even.',
  },
  {
    id: 'sugar',
    minimumC: 160,
    maximumC: 190,
    title: 'Sugar degradation and caramelization grow',
    kind: 'chemistry',
    visual: 'Tan becomes cinnamon and light brown; sweetness and toasted-sugar aromas intensify.',
    process:
      'Sucrose depletion and thermal sugar reactions become increasingly important alongside Maillard and Strecker chemistry.',
    timeEffect:
      'Moderate exposure can deepen perceived sweetness and roundness. Continued high exposure consumes precursors and moves toward bitter, roasty products.',
    cupDirection:
      'Often shifts from bright and cereal-like toward caramel, chocolate, and fuller sweetness, then toward bitterness.',
  },
  {
    id: 'aroma-first-crack',
    minimumC: 190,
    maximumC: 205,
    title: 'Aroma formation and first crack region',
    kind: 'milestone',
    visual:
      'Cinnamon to medium brown; beans expand and first crack may begin as internal gas pressure fractures the structure.',
    process:
      'Flavor-generating reactions become intense and pyrolytic reactions begin to matter. First crack is a physical milestone, not one exact chemical temperature.',
    timeEffect:
      'Time and heat momentum here strongly affect whether the roast enters development cleanly. Racing through can taste sharp or underdeveloped; stalling can taste flat or baked.',
    cupDirection:
      'The balance begins moving from origin-led acidity toward developed sweetness, body, and recognizable roast character.',
  },
  {
    id: 'development',
    minimumC: 205,
    maximumC: 220,
    title: 'Post-crack development',
    kind: 'milestone',
    visual: 'Medium brown deepens; the surface remains mostly dry before darker endpoints.',
    process:
      'Maillard, Strecker, sugar degradation, acid breakdown, gas formation, and pyrolysis continue together. No single reaction owns this phase.',
    timeEffect:
      'More time generally lowers perceived acidity and increases solubility, body, roast flavor, and bitterness. Too little may leave grassy, peanut-like, or sharp notes; too much masks the coffee.',
    cupDirection:
      'Use this band to choose the brightness-to-body balance, while watching the actual curve rather than development percentage alone.',
  },
  {
    id: 'second-crack',
    minimumC: 220,
    maximumC: 230,
    title: 'Second crack region',
    kind: 'milestone',
    visual: 'Dark brown; sharper crackling may begin and oils can migrate toward the surface.',
    process:
      'Cell structure breaks down further while pyrolysis, smoke-producing reactions, and loss of origin volatiles accelerate.',
    timeEffect:
      'Small additions of time create large sensory changes. The window between dark, bittersweet, smoky, and burnt becomes narrow.',
    cupDirection: 'Lower acidity, heavier roast identity, smoke, spice, bitterness, and reduced varietal distinction.',
  },
  {
    id: 'carbonization',
    minimumC: 230,
    title: 'Deep pyrolysis and carbonization risk',
    kind: 'risk',
    visual: 'Very dark brown to nearly black; visible surface oil and smoke become likely.',
    process: 'Thermal breakdown dominates formation of delicate aroma. Charring and combustion risk rise quickly.',
    timeEffect:
      'Additional time rapidly destroys sweetness and origin character. This is a safety and defect region, not a useful target for this project.',
    cupDirection: 'Ash, carbon, intense bitterness, thin aroma definition, and high roast dominance.',
  },
]

export const roastColorStops: RoastColorStop[] = [
  { temperatureC: 25, name: 'Green', color: '#718467', cue: 'Dense green coffee before meaningful drying.' },
  { temperatureC: 150, name: 'Yellow', color: '#c6a85a', cue: 'Drying end vicinity; straw and cereal aromas.' },
  { temperatureC: 170, name: 'Tan', color: '#ad7c48', cue: 'Browning is clearly underway.' },
  { temperatureC: 185, name: 'Cinnamon', color: '#8f5938', cue: 'Light roast color before first crack.' },
  { temperatureC: 196, name: 'Light brown', color: '#75452f', cue: 'First-crack vicinity on many systems.' },
  { temperatureC: 205, name: 'Medium brown', color: '#593223', cue: 'Post-crack development.' },
  { temperatureC: 220, name: 'Dark brown', color: '#38231c', cue: 'Approaching second-crack territory.' },
  { temperatureC: 230, name: 'Very dark', color: '#211a17', cue: 'Oil, smoke, and carbonization risk increase.' },
]

/**
 * Traditional roast-degree names are shorthand, not standards. These approximate
 * internal-bean endpoints follow the practical table in the Quest roaster handbook;
 * they are deliberately separate from Crackle's measured probe temperatures.
 */
export const roastStyleReferences: RoastStyleReference[] = [
  {
    id: 'cinnamon',
    names: 'Cinnamon',
    family: 'Very light',
    minimumC: 200,
    colorName: 'Pale cinnamon brown',
    color: '#8f5938',
    landmark: 'Around the beginning of first crack.',
  },
  {
    id: 'new-england-american',
    names: 'New England / American',
    family: 'Light',
    minimumC: 205,
    maximumC: 210,
    colorName: 'Light brown',
    color: '#7d4b34',
    landmark: 'First crack is active; the surface remains dry.',
  },
  {
    id: 'city',
    names: 'City',
    family: 'Light-medium',
    minimumC: 219,
    colorName: 'Even medium brown',
    color: '#633927',
    landmark: 'Traditionally near the end of first crack.',
  },
  {
    id: 'city-plus',
    names: 'City+',
    family: 'Medium',
    minimumC: 224,
    colorName: 'Medium-dark brown',
    color: '#533022',
    landmark: 'After first crack, before second crack.',
  },
  {
    id: 'full-city',
    names: 'Full City',
    family: 'Medium-dark',
    minimumC: 229,
    colorName: 'Dark brown',
    color: '#44281e',
    landmark: 'Traditionally just before second crack.',
  },
  {
    id: 'full-city-plus',
    names: 'Full City+',
    family: 'Dark',
    minimumC: 234,
    colorName: 'Deep dark brown',
    color: '#38231c',
    landmark: 'At the first few snaps of second crack; a slight oil sheen may appear.',
  },
  {
    id: 'vienna',
    names: 'Vienna',
    family: 'Dark',
    minimumC: 239,
    colorName: 'Very dark brown',
    color: '#2c201b',
    landmark: 'Into second crack; surface oil becomes more likely.',
  },
  {
    id: 'italian-french',
    names: 'Italian / French',
    family: 'Very dark',
    minimumC: 243,
    maximumC: 245,
    colorName: 'Near-black and oily',
    color: '#1b1613',
    landmark: 'Late second crack; smoke, carbonization, and fire risk rise quickly.',
  },
]

export const celsiusToFahrenheit = (temperatureC: number) => (temperatureC * 9) / 5 + 32

export const formatReferenceRange = (minimumC: number, maximumC?: number) => {
  const minimumF = Math.round(celsiusToFahrenheit(minimumC))
  if (maximumC == null) return { celsius: `${minimumC}+ °C`, fahrenheit: `${minimumF}+ °F` }
  return {
    celsius: `${minimumC}-${maximumC} °C`,
    fahrenheit: `${minimumF}-${Math.round(celsiusToFahrenheit(maximumC))} °F`,
  }
}

export const formatApproximateTemperature = (minimumC: number, maximumC?: number) => {
  const minimumF = Math.round(celsiusToFahrenheit(minimumC))
  if (maximumC == null) return { celsius: `${minimumC} °C`, fahrenheit: `${minimumF} °F` }
  return {
    celsius: `${minimumC}-${maximumC} °C`,
    fahrenheit: `${minimumF}-${Math.round(celsiusToFahrenheit(maximumC))} °F`,
  }
}
