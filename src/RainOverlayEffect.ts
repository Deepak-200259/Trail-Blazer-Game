import * as THREE from 'three'

type RainOverlayOptions = {
  intensity?: number
  speed?: number
  brightness?: number
  overlayOnly?: boolean
  zoom?: number
}

/**
 * Fullscreen rain compositor based on the rocksdanister shader style.
 * API only needs scene + camera; background texture is read from `scene.background`.
 */
export class RainOverlayEffect {
  private readonly scene: THREE.Scene
  private readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  private readonly uniforms: Record<string, THREE.IUniform<unknown>>
  private readonly resolution = new THREE.Vector2(window.innerWidth, window.innerHeight)
  private readonly texResolution = new THREE.Vector2(window.innerWidth, window.innerHeight)
  private readonly fallbackTex: THREE.DataTexture

  constructor(scene: THREE.Scene, camera: THREE.Camera, opts: RainOverlayOptions = {}) {
    this.scene = scene
    void camera

    this.fallbackTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat)
    this.fallbackTex.needsUpdate = true
    this.fallbackTex.colorSpace = THREE.SRGBColorSpace
    const baseTex = this.resolveBackgroundTexture()

    this.uniforms = {
      u_tex0: { value: baseTex },
      u_tex0_resolution: { value: this.texResolution },
      u_time: { value: 0 },
      u_resolution: { value: this.resolution },
      u_speed: { value: opts.speed ?? 1.0 },
      u_intensity: { value: opts.intensity ?? 0.42 },
      u_normal: { value: 0.5 },
      u_brightness: { value: opts.brightness ?? 1.0 },
      u_blur_intensity: { value: 0.5 },
      u_zoom: { value: opts.zoom ?? 1.9 },
      u_blur_iterations: { value: 1 },
      u_panning: { value: false },
      u_post_processing: { value: false },
      u_lightning: { value: false },
      u_texture_fill: { value: true },
      u_overlay_only: { value: opts.overlayOnly ?? false },
    }

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: (opts.overlayOnly ?? false),
      depthWrite: false,
      depthTest: false,
      blending: (opts.overlayOnly ?? false) ? THREE.NormalBlending : THREE.NoBlending,
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        #ifdef GL_ES
        precision highp float;
        #endif

        varying vec2 vUv;
        uniform sampler2D u_tex0;
        uniform vec2 u_tex0_resolution;
        uniform float u_time;
        uniform vec2 u_resolution;
        uniform float u_speed;
        uniform float u_intensity;
        uniform float u_normal;
        uniform float u_brightness;
        uniform float u_blur_intensity;
        uniform float u_zoom;
        uniform int u_blur_iterations;
        uniform bool u_panning;
        uniform bool u_post_processing;
        uniform bool u_lightning;
        uniform bool u_texture_fill;
        uniform bool u_overlay_only;

        #define S(a, b, t) smoothstep(a, b, t)

        vec3 N13(float p) {
          vec3 p3 = fract(vec3(p) * vec3(.1031, .11369, .13787));
          p3 += dot(p3, p3.yzx + 19.19);
          return fract(vec3((p3.x + p3.y) * p3.z, (p3.x + p3.z) * p3.y, (p3.y + p3.z) * p3.x));
        }

        float N(float t) {
          return fract(sin(t * 12345.564) * 7658.76);
        }

        float Saw(float b, float t) {
          return S(0., b, t) * S(1., b, t);
        }

        vec2 DropLayer2(vec2 uv, float t) {
          vec2 UV = uv;
          uv.y += t * 0.75;
          vec2 a = vec2(6., 1.);
          vec2 grid = a * 2.;
          vec2 id = floor(uv * grid);

          float colShift = N(id.x);
          uv.y += colShift;

          id = floor(uv * grid);
          vec3 n = N13(id.x * 35.2 + id.y * 2376.1);
          vec2 st = fract(uv * grid) - vec2(.5, 0.);

          float x = n.x - .5;
          float y = UV.y * 20.;
          float wiggle = sin(y + sin(y));
          x += wiggle * (.5 - abs(x)) * (n.z - .5);
          x *= .7;
          float ti = fract(t + n.z);
          y = (Saw(.85, ti) - .5) * .9 + .5;
          vec2 p = vec2(x, y);

          float d = length((st - p) * a.yx);
          float mainDrop = S(.4, .0, d);

          float r = sqrt(S(1., y, st.y));
          float cd = abs(st.x - x);
          float trail = S(.23 * r, .15 * r * r, cd);
          float trailFront = S(-.02, .02, st.y - y);
          trail *= trailFront * r * r;

          y = UV.y;
          float trail2 = S(.2 * r, .0, cd);
          float droplets = max(0., (sin(y * (1. - y) * 120.) - st.y)) * trail2 * trailFront * n.z;
          y = fract(y * 10.) + (st.y - .5);
          float dd = length(st - vec2(x, y));
          droplets = S(.3, 0., dd);
          float m = mainDrop + droplets * r * trailFront;

          return vec2(m, trail);
        }

        float StaticDrops(vec2 uv, float t) {
          uv *= 40.;
          vec2 id = floor(uv);
          uv = fract(uv) - .5;
          vec3 n = N13(id.x * 107.45 + id.y * 3543.654);
          vec2 p = (n.xy - .5) * .7;
          float d = length(uv - p);

          float fade = Saw(.025, fract(t + n.z));
          float c = S(.3, 0., d) * fract(n.z * 10.) * fade;
          return c;
        }

        vec2 Drops(vec2 uv, float t, float l0, float l1, float l2) {
          float s = StaticDrops(uv, t) * l0;
          vec2 m1 = DropLayer2(uv, t) * l1;
          vec2 m2 = DropLayer2(uv * 1.85, t) * l2;

          float c = s + m1.x + m2.x;
          c = S(.3, 1., c);
          return vec2(c, max(m1.y * l0, m2.y * l1));
        }

        float N21(vec2 p) {
          p = fract(p * vec2(123.34, 345.45));
          p += dot(p, p + 34.345);
          return fract(p.x * p.y);
        }

        void main() {
          vec2 uv = (vUv * u_resolution.xy - .5 * u_resolution.xy) / u_resolution.y;
          vec2 UV = vUv;
          float T = u_time;

          if(u_texture_fill) {
            float screenAspect = u_resolution.x / u_resolution.y;
            float textureAspect = u_tex0_resolution.x / u_tex0_resolution.y;
            float scaleX = 1.;
            float scaleY = 1.;
            if(textureAspect > screenAspect) scaleX = screenAspect / textureAspect;
            else scaleY = textureAspect / screenAspect;
            UV = vec2(scaleX, scaleY) * (UV - 0.5) + 0.5;
          }

          float t = T * .2 * u_speed;
          float rainAmount = u_intensity;
          float zoom = u_panning ? -cos(T * .2) : 0.;
          uv *= (.7 + zoom * .3) * u_zoom;

          float staticDrops = S(-.5, 1., rainAmount) * 2.;
          float layer1 = S(.25, .75, rainAmount);
          float layer2 = S(.0, .5, rainAmount);

          vec2 c = Drops(uv, t, staticDrops, layer1, layer2);
          float rainMask = clamp(c.x, 0., 1.);
          vec2 e = vec2(.001, 0.) * u_normal;
          float cx = Drops(uv + e, t, staticDrops, layer1, layer2).x;
          float cy = Drops(uv + e.yx, t, staticDrops, layer1, layer2).x;
          vec2 n = vec2(cx - c.x, cy - c.x);

          vec3 col = texture2D(u_tex0, UV + n).rgb;
          vec4 texCoord = vec4(UV.x + n.x, UV.y + n.y, 0., 25. * 0.01 / 7.);

          if(u_blur_iterations != 1) {
            float blur = u_blur_intensity * 0.01;
            float a = N21(gl_FragCoord.xy) * 6.2831;
            for(int m = 0; m < 64; m++) {
              if(m > u_blur_iterations) break;
              vec2 offs = vec2(sin(a), cos(a)) * blur;
              float d = fract(sin((float(m) + 1.) * 546.) * 5424.);
              d = sqrt(d);
              offs *= d;
              col += texture2D(u_tex0, texCoord.xy + offs).xyz;
              a++;
            }
            col /= float(u_blur_iterations);
          }

          t = (T + 3.) * .5;
          /* Keep source colors untouched; no grade/tint pass. */
          if(u_post_processing) { col *= vec3(1.); }
          float fade = S(0., 10., T);

          if(u_lightning) {
            float lightning = sin(t * sin(t * 10.));
            lightning *= pow(max(0., sin(t + sin(t))), 10.);
            col *= 1. + lightning * fade * mix(1., .1, 0.);
          }

          /* No vignette so the background keeps original brightness edge-to-edge. */
          col *= 1.0;
          if (u_overlay_only) {
            /* Very light blue watery tint (avoids white/milky look). */
            float alpha = rainMask * 0.18;
            gl_FragColor = vec4(vec3(0.82, 0.9, 1.0), alpha);
          } else {
            gl_FragColor = vec4(col * u_brightness, 1.);
          }
        }
      `,
    })

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat)
    this.quad.frustumCulled = false
    this.quad.renderOrder = 9_999
    this.scene.add(this.quad)
  }

  update(dt: number): void {
    this.uniforms.u_time.value = (this.uniforms.u_time.value as number) + dt
    const dpr = window.devicePixelRatio || 1
    this.resolution.set(window.innerWidth * dpr, window.innerHeight * dpr)
    this.uniforms.u_tex0.value = this.resolveBackgroundTexture()
  }

  setIntensity(value: number): void {
    this.uniforms.u_intensity.value = THREE.MathUtils.clamp(value, 0, 1)
  }

  dispose(): void {
    this.scene.remove(this.quad)
    this.quad.geometry.dispose()
    this.quad.material.dispose()
    this.fallbackTex.dispose()
  }

  private resolveBackgroundTexture(): THREE.Texture {
    const bg = this.scene.background
    const tex = bg instanceof THREE.Texture ? bg : this.fallbackTex
    const image = tex.image as { width?: number; height?: number } | undefined
    this.texResolution.set(image?.width ?? window.innerWidth, image?.height ?? window.innerHeight)
    return tex
  }
}
