// Shaders WebGL2 de la forme liquide. Tout est décrit en champs de distance signés (SDF),
// en pixels logiques, repère de la fenêtre (origine en haut à gauche, y vers le bas).
// Primitives fusionnées par minimum lisse :
//   - le bord haut de l'écran : un demi-plan juste au-dessus de la fenêtre ;
//   - la bosse (lip) : une ellipse centrée sur le bord, d'où part la coulure ;
//   - le fil : une capsule effilée du bord jusqu'à sa pointe — le centre de la tête tant qu'il
//     tient, puis une pointe qui remonte vers le bord une fois cassé ;
//   - la tête : un rectangle à coins arrondis de rayon maximal — cercle quand ses deux
//     demi-dimensions sont égales (goutte), pilule quand elle s'élargit.
// Voir docs/animation.md.

export const vertexSource = /* glsl */ `#version 300 es
void main() {
  // Triangle unique couvrant tout le canevas, sans tampon de sommets.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const fragmentSource = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uSize;      // taille de la fenêtre, px logiques
uniform float uDpr;      // pixels physiques par pixel logique
uniform vec4 uHead;      // centre x, centre y, demi-largeur, demi-hauteur
uniform vec3 uThread;    // rayon côté pointe, rayon côté bord, y de la pointe
uniform vec2 uLip;       // demi-largeur, hauteur de la bosse
uniform vec3 uSmooth;    // décalage du bord, fusion bord, fusion tête
uniform vec4 uFill;      // couleur de remplissage (rgb, alpha)
uniform vec4 uShadow;    // couleur de l'ombre (rgb), opacité
uniform vec2 uShadowGeo; // flou, décalage vertical

out vec4 outColor;

float smin(float a, float b, float k) {
  if (k <= 0.0) return min(a, b);
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float sdPill(vec2 p, vec2 b) {
  float r = min(b.x, b.y);
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

float sdEllipse(vec2 p, vec2 ab) {
  float k0 = length(p / ab);
  float k1 = length(p / (ab * ab));
  return k1 > 0.0 ? k0 * (k0 - 1.0) / k1 : -min(ab.x, ab.y);
}

// Capsule verticale à rayons différents, de y = 0 (rayon r1) à y = h (rayon r2), y vers le haut.
float sdUnevenCapsule(vec2 p, float r1, float r2, float h) {
  p.x = abs(p.x);
  float b = (r1 - r2) / h;
  float a = sqrt(max(1.0 - b * b, 0.0));
  float k = dot(p, vec2(-b, a));
  if (k < 0.0) return length(p) - r1;
  if (k > a * h) return length(p - vec2(0.0, h)) - r2;
  return dot(p, vec2(a, b)) - r1;
}

float sdHead(vec2 p) {
  if (min(uHead.z, uHead.w) < 0.25) return 1e5;
  return sdPill(p - uHead.xy, uHead.zw);
}

float scene(vec2 p) {
  float cx = uSize.x * 0.5;
  float edge = uSmooth.x;
  float d = p.y + edge;

  if (uLip.y > 0.05 && uLip.x > 0.05) {
    d = smin(d, sdEllipse(p - vec2(cx, -edge), vec2(uLip.x, uLip.y + edge)), uSmooth.y);
  }

  float anchorY = -edge - 2.0;
  float tipY = uThread.z;
  float h = tipY - anchorY;
  float rMax = max(uThread.x, uThread.y);
  if (rMax > 0.05 && h > abs(uThread.x - uThread.y) + 0.5) {
    vec2 q = vec2(p.x - uHead.x, tipY - p.y);
    d = smin(d, sdUnevenCapsule(q, max(uThread.x, 0.0), max(uThread.y, 0.0), h), uSmooth.y);
  }

  return smin(d, sdHead(p), uSmooth.z);
}

void main() {
  vec2 frag = gl_FragCoord.xy / uDpr;
  vec2 p = vec2(frag.x, uSize.y - frag.y);

  float d = scene(p);
  // Couverture anti-crénelée : la distance est convertie en pixels physiques.
  float coverage = clamp(0.5 - d * uDpr, 0.0, 1.0);
  float fillA = coverage * uFill.a;

  // Ombre portée de la tête seule : celle du bord ferait une bande sur toute la largeur.
  float shadowA = 0.0;
  if (uShadow.a > 0.0) {
    float sd = sdHead(p - vec2(0.0, uShadowGeo.y));
    shadowA = uShadow.a * (1.0 - smoothstep(-uShadowGeo.x * 0.25, uShadowGeo.x, sd));
  }

  float a = fillA + shadowA * (1.0 - fillA);
  vec3 rgb = uFill.rgb * fillA + uShadow.rgb * shadowA * (1.0 - fillA);
  outColor = vec4(rgb, a);
}
`;
