/**
 * OneArt Photo Studio — WebGL-Accelerated Client-Side Image Processing Engine
 * ===========================================================================
 * A WebGL 1.0 implementation of the image filter pipeline for 60 FPS live updates.
 */

const OneArtWebGL = (function () {
  'use strict';

  let gl = null;
  let canvas = null;
  let program = null;
  let sourceTexture = null;
  let curveTexture = null;
  let subjectMaskTexture = null;
  let hasSubjectMask = false;
  let imageWidth = 0;
  let imageHeight = 0;

  // Vertex Shader
  const vsSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_texCoord = a_texCoord;
    }
  `;
  // Fragment Shader
  const fsSource = `
    precision mediump float;
    varying vec2 v_texCoord;
    
    uniform sampler2D u_texture;
    uniform sampler2D u_curveTexture;
    
    // Tone Adjust
    uniform float u_brightness;
    uniform float u_contrast;
    uniform float u_light_balance;
    uniform float u_highlights;
    uniform float u_shadows;
    uniform float u_warmth;
    
    // Saturation / Vibrance
    uniform float u_saturation;
    uniform float u_vibrance;
    
    // White Balance
    uniform vec3 u_wb_gains;
    
    // Noise & Vignette
    uniform float u_noise_level;
    uniform float u_blue_bias;
    uniform float u_outer_brightness;
    uniform float u_inner_brightness;
    
    // Lens Distortion
    uniform float u_distortion;
    uniform float u_chromatic_aberration;
    uniform float u_edge_softness;
    uniform bool u_aberration_radial;
    
    // Split Toning
    uniform bool u_split_toning_enabled;
    uniform vec3 u_split_shadow_color;
    uniform vec3 u_split_highlight_color;
    uniform float u_split_balance;
    
    // Gradient Map
    uniform bool u_gradient_map_enabled;
    uniform int u_gradient_preset;
    uniform float u_gradient_intensity;
    
    // LUT
    uniform int u_lut_look; // 0=None, 1=Teal&Orange, 2=Kodak, 3=Fuji, 4=Noir, 5=Vintage, 6=Cyberpunk
    uniform float u_lut_intensity;
    
    // Style FX
    uniform int u_style_mode; // 0=None, 1=Bloom, 2=SoftPortrait, 3=CinematicGrade, 4=Halation, 5=RetroFilm, 6=Duotone, 7=Matte, 8=GlitchArt, 9=BokehBlur, 10=PixelSorting
    uniform float u_style_strength;
    uniform float u_style_radius;
    uniform float u_style_threshold;
    uniform float u_style_seed;
    
    uniform bool u_curves_enabled;
    uniform vec2 u_resolution;

    // Portrait Bokeh
    uniform bool u_portrait_bokeh_enabled;
    uniform float u_bokeh_radius;
    uniform float u_bokeh_sides;
    uniform float u_bokeh_rotation;
    uniform float u_bokeh_boost;
    uniform int u_bokeh_mask_mode; // 0=auto, 1=radial, 2=linear, 3=none
    uniform float u_bokeh_mask_center_x;
    uniform float u_bokeh_mask_center_y;
    uniform float u_bokeh_mask_radius;
    uniform float u_bokeh_mask_angle;
    uniform float u_bokeh_mask_hardness;
    uniform sampler2D u_subject_mask_texture;
    uniform bool u_has_subject_mask;

    // Style Match (CIELAB Reinhard Transfer)
    uniform bool u_style_transfer_enabled;
    uniform float u_style_transfer_intensity;
    uniform vec3 u_style_transfer_mean_src;
    uniform vec3 u_style_transfer_std_src;
    uniform vec3 u_style_transfer_mean_ref;
    uniform vec3 u_style_transfer_std_ref;

    // Creative FX
    uniform bool u_infrared_enabled;
    uniform float u_infrared_intensity;
    uniform bool u_prism_enabled;
    uniform int u_prism_mode; // 1=Kaleidoscope, 2=Triple Split, 3=Refraction Ring, 4=Chromatic Edge
    uniform float u_prism_intensity;
    uniform bool u_light_leaks_enabled;
    uniform float u_light_leaks_intensity;
    uniform float u_leak_centers_x[3];
    uniform float u_leak_centers_y[3];
    uniform vec3 u_leak_colors[3];
    uniform float u_leak_radius_x[3];
    uniform float u_leak_radius_y[3];
    uniform float u_leak_strength[3];
    uniform bool u_stencil_enabled;
    uniform int u_stencil_mode; // 1=Classic Red/Black, 2=Cyber Neon, 3=High-Contrast B&W
    uniform float u_stencil_threshold;
    uniform float u_stencil_spray;

    // Helper to blend 3 colors:
    vec3 evalGradient3(float t, vec3 c1, vec3 c2, vec3 c3) {
      if (t < 0.5) {
        return mix(c1, c2, t * 2.0);
      } else {
        return mix(c2, c3, (t - 0.5) * 2.0);
      }
    }

    vec3 evalGradient2(float t, vec3 c1, vec3 c2) {
      return mix(c1, c2, t);
    }

    // Pseudo-random generator for noise
    float rand(vec2 co) {
      return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    }

    // L*a*b* conversion helpers
    float f_t(float t) {
      if (t > 0.008856) {
        return pow(t, 0.33333333);
      } else {
        return 7.787 * t + (16.0 / 116.0);
      }
    }
    
    vec3 rgb2lab(vec3 rgb) {
      vec3 linRGB;
      if (rgb.r > 0.04045) linRGB.r = pow((rgb.r + 0.055) / 1.055, 2.4);
      else linRGB.r = rgb.r / 12.92;
      if (rgb.g > 0.04045) linRGB.g = pow((rgb.g + 0.055) / 1.055, 2.4);
      else linRGB.g = rgb.g / 12.92;
      if (rgb.b > 0.04045) linRGB.b = pow((rgb.b + 0.055) / 1.055, 2.4);
      else linRGB.b = rgb.b / 12.92;
      
      float x = (linRGB.r * 0.4124564 + linRGB.g * 0.3575761 + linRGB.b * 0.1804375) / 0.95047;
      float y = (linRGB.r * 0.2126729 + linRGB.g * 0.7151522 + linRGB.b * 0.0721750) / 1.00000;
      float z = (linRGB.r * 0.0193339 + linRGB.g * 0.1191920 + linRGB.b * 0.9503041) / 1.08883;
      
      x = max(x, 0.0);
      y = max(y, 0.0);
      z = max(z, 0.0);
      
      float fx = f_t(x);
      float fy = f_t(y);
      float fz = f_t(z);
      
      float L = 116.0 * fy - 16.0;
      float a = 500.0 * (fx - fy);
      float b = 200.0 * (fy - fz);
      
      float L_cv = L * (255.0 / 100.0);
      float a_cv = a + 128.0;
      float b_cv = b + 128.0;
      
      return vec3(L_cv, a_cv, b_cv);
    }
    
    float f_inv(float t) {
      float t3 = t * t * t;
      if (t3 > 0.008856) {
        return t3;
      } else {
        return (t - 16.0 / 116.0) / 7.787;
      }
    }
    
    vec3 lab2rgb(vec3 lab) {
      float L = lab.x * (100.0 / 255.0);
      float a = lab.y - 128.0;
      float b = lab.z - 128.0;
      
      float y = (L + 16.0) / 116.0;
      float x = a / 500.0 + y;
      float z = y - b / 200.0;
      
      float x_norm = f_inv(x) * 0.95047;
      float y_norm = f_inv(y) * 1.00000;
      float z_norm = f_inv(z) * 1.08883;
      
      vec3 linRGB;
      linRGB.r = x_norm * 3.2404542 + y_norm * -1.5371385 + z_norm * -0.4985314;
      linRGB.g = x_norm * -0.9692660 + y_norm * 1.8760108 + z_norm * 0.0415560;
      linRGB.b = x_norm * 0.0556434 + y_norm * -0.2040259 + z_norm * 1.0572252;
      
      linRGB = clamp(linRGB, 0.0, 1.0);
      
      vec3 srgb;
      if (linRGB.r > 0.0031308) srgb.r = 1.055 * pow(linRGB.r, 0.41666667) - 0.055;
      else srgb.r = 12.92 * linRGB.r;
      if (linRGB.g > 0.0031308) srgb.g = 1.055 * pow(linRGB.g, 0.41666667) - 0.055;
      else srgb.g = 12.92 * linRGB.g;
      if (linRGB.b > 0.0031308) srgb.b = 1.055 * pow(linRGB.b, 0.41666667) - 0.055;
      else srgb.b = 12.92 * linRGB.b;
      
      return clamp(srgb, 0.0, 1.0);
    }
    
    // Process color helper
    vec3 getProcessedColor(vec2 sampleUV) {
      vec3 col = texture2D(u_texture, sampleUV).rgb;
      col *= u_wb_gains;
      col = clamp(col, 0.0, 1.0);
      
      if (u_lut_intensity > 0.0 && u_lut_look != 0) {
        vec3 lutColor = col;
        float luma = dot(lutColor, vec3(0.299, 0.587, 0.114));
        if (u_lut_look == 1) { // Teal & Orange
          float sMask = clamp((0.5 - luma) * 2.0, 0.0, 1.0);
          lutColor.r -= u_lut_intensity * 0.08 * sMask;
          lutColor.g += u_lut_intensity * 0.05 * sMask;
          lutColor.b += u_lut_intensity * 0.15 * sMask;
          float hMask = clamp((luma - 0.5) * 2.0, 0.0, 1.0);
          lutColor.r += u_lut_intensity * 0.15 * hMask;
          lutColor.g += u_lut_intensity * 0.06 * hMask;
          lutColor.b -= u_lut_intensity * 0.10 * hMask;
        } 
        else if (u_lut_look == 2) { // Kodak Portra
          lutColor.r *= (1.0 + u_lut_intensity * 0.05);
          lutColor.b *= (1.0 - u_lut_intensity * 0.05);
          lutColor = mix(lutColor, vec3(luma), u_lut_intensity * 0.15);
          lutColor = (lutColor - 0.5) * (1.0 - u_lut_intensity * 0.08) + 0.5;
        } 
        else if (u_lut_look == 3) { // Fuji Superia
          float sMask = clamp((0.45 - luma) * 2.2, 0.0, 1.0);
          lutColor.r += u_lut_intensity * 0.04 * sMask;
          lutColor.b += u_lut_intensity * 0.08 * sMask;
          lutColor.g *= (1.0 + u_lut_intensity * 0.08);
          lutColor.r *= (1.0 + u_lut_intensity * 0.06);
        } 
        else if (u_lut_look == 4) { // Monochrome Noir
          vec3 noir = vec3(lutColor.r * 0.60 + lutColor.g * 0.35 + lutColor.b * 0.05);
          noir = clamp((noir - 0.45) * (1.0 + u_lut_intensity * 0.5) + 0.45, 0.0, 1.0);
          lutColor = mix(lutColor, noir, u_lut_intensity);
        } 
        else if (u_lut_look == 5) { // Vintage Gold
          float factor = 1.0 - u_lut_intensity * 0.08;
          lutColor = lutColor * factor + u_lut_intensity * 0.08;
          lutColor.r *= (1.0 + u_lut_intensity * 0.12);
          lutColor.g *= (1.0 + u_lut_intensity * 0.08);
          lutColor.b *= (1.0 - u_lut_intensity * 0.12);
          lutColor = mix(lutColor, vec3(luma), u_lut_intensity * 0.20);
        } 
        else if (u_lut_look == 6) { // Cyberpunk
          float sMask = clamp((0.5 - luma) * 2.0, 0.0, 1.0);
          lutColor.r += u_lut_intensity * 0.16 * sMask;
          lutColor.b += u_lut_intensity * 0.16 * sMask;
          lutColor.g -= u_lut_intensity * 0.08 * sMask;
          float hMask = clamp((luma - 0.5) * 2.0, 0.0, 1.0);
          lutColor.r -= u_lut_intensity * 0.12 * hMask;
          lutColor.g += u_lut_intensity * 0.16 * hMask;
          lutColor.b += u_lut_intensity * 0.16 * hMask;
        }
        col = clamp(lutColor, 0.0, 1.0);
      }
      
      if (u_brightness != 1.0) {
        col *= u_brightness;
      }
      if (u_contrast != 1.0) {
        col = (col - 0.5) * u_contrast + 0.5;
      }
      
      float luma2 = dot(col, vec3(0.299, 0.587, 0.114));
      if (u_light_balance != 0.0) {
        float midMask = 1.0 - abs(luma2 - 0.5) * 2.0;
        col += u_light_balance * 0.10 * midMask;
      }
      if (u_highlights != 0.0) {
        float hMask = clamp((luma2 - 0.5) * 2.0, 0.0, 1.0);
        col += (u_highlights * 0.18 * hMask) * (1.0 - col);
      }
      if (u_shadows != 0.0) {
        float sMask = clamp((0.5 - luma2) * 2.0, 0.0, 1.0);
        col += (u_shadows * 0.18 * sMask) * (1.0 - col);
      }
      if (u_warmth != 0.0) {
        col.r *= (1.0 + u_warmth * 0.16);
        col.g *= (1.0 + u_warmth * 0.03);
        col.b *= (1.0 - u_warmth * 0.16);
      }
      return clamp(col, 0.0, 1.0);
    }
    
    // 9-tap blur helper (uses vec2 cast for WebGL 1.0 scalar division compatibility)
    vec3 getBlur(vec2 uv, float radius) {
      vec2 step = vec2(radius) / u_resolution;
      vec3 sum = vec3(0.0);
      sum += getProcessedColor(uv + vec2(-1.0, -1.0) * step) * 0.0625;
      sum += getProcessedColor(uv + vec2( 0.0, -1.0) * step) * 0.125;
      sum += getProcessedColor(uv + vec2( 1.0, -1.0) * step) * 0.0625;
      sum += getProcessedColor(uv + vec2(-1.0,  0.0) * step) * 0.125;
      sum += getProcessedColor(uv + vec2( 0.0,  0.0) * step) * 0.25;
      sum += getProcessedColor(uv + vec2( 1.0,  0.0) * step) * 0.125;
      sum += getProcessedColor(uv + vec2(-1.0,  1.0) * step) * 0.0625;
      sum += getProcessedColor(uv + vec2( 0.0,  1.0) * step) * 0.125;
      sum += getProcessedColor(uv + vec2( 1.0,  1.0) * step) * 0.0625;
      return sum;
    }
    
    // Halation helpers
    float getHighlight(vec3 col, float thresh) {
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      float mask = clamp((l - thresh) / max(1e-4, 1.0 - thresh), 0.0, 1.0);
      return pow(mask, 1.6);
    }
    
    float getBlurHighlight(vec2 uv, float radius, float thresh) {
      vec2 step = vec2(radius) / u_resolution;
      float sum = 0.0;
      sum += getHighlight(getProcessedColor(uv + vec2(-1.0, -1.0) * step), thresh) * 0.0625;
      sum += getHighlight(getProcessedColor(uv + vec2( 0.0, -1.0) * step), thresh) * 0.125;
      sum += getHighlight(getProcessedColor(uv + vec2( 1.0, -1.0) * step), thresh) * 0.0625;
      sum += getHighlight(getProcessedColor(uv + vec2(-1.0,  0.0) * step), thresh) * 0.125;
      sum += getHighlight(getProcessedColor(uv + vec2( 0.0,  0.0) * step), thresh) * 0.25;
      sum += getHighlight(getProcessedColor(uv + vec2( 1.0,  0.0) * step), thresh) * 0.125;
      sum += getHighlight(getProcessedColor(uv + vec2(-1.0,  1.0) * step), thresh) * 0.0625;
      sum += getHighlight(getProcessedColor(uv + vec2( 0.0,  1.0) * step), thresh) * 0.125;
      sum += getHighlight(getProcessedColor(uv + vec2( 1.0,  1.0) * step), thresh) * 0.0625;
      return sum;
    }
    
    // Bloom helpers
    float getBloomHighlightVal(vec3 col, float thresh) {
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      float mask = clamp((l - thresh) / max(1e-4, 1.0 - thresh), 0.0, 1.0);
      return pow(mask, 1.2);
    }
    
    float getBlurBloomHighlight(vec2 uv, float radius, float thresh) {
      vec2 step = vec2(radius) / u_resolution;
      float sum = 0.0;
      sum += getBloomHighlightVal(getProcessedColor(uv + vec2(-1.0, -1.0) * step), thresh) * 0.0625;
      sum += getBloomHighlightVal(getProcessedColor(uv + vec2( 0.0, -1.0) * step), thresh) * 0.125;
      sum += getBloomHighlightVal(getProcessedColor(uv + vec2( 1.0, -1.0) * step), thresh) * 0.0625;
      sum += getBloomHighlightVal(getProcessedColor(uv + vec2(-1.0,  0.0) * step), thresh) * 0.125;
      sum += getBloomHighlightVal(getProcessedColor(uv + vec2( 0.0,  0.0) * step), thresh) * 0.25;
      sum += getBloomHighlightVal(getProcessedColor(uv + vec2( 1.0,  0.0) * step), thresh) * 0.125;
      sum += getBloomHighlightVal(getProcessedColor(uv + vec2(-1.0,  1.0) * step), thresh) * 0.0625;
      sum += getBloomHighlightVal(getProcessedColor(uv + vec2( 0.0,  1.0) * step), thresh) * 0.125;
      sum += getBloomHighlightVal(getProcessedColor(uv + vec2( 1.0,  1.0) * step), thresh) * 0.0625;
      return sum;
    }

    bool inPolygon(vec2 p, float r, float sides, float rot) {
      float d = length(p);
      if (d > r) return false;
      if (sides == -1.0) {
        // Donut / Ring aperture for reflex lenses
        return d <= r && d >= r * 0.45;
      }
      if (sides < 3.0) return d <= r;
      float theta = atan(p.y, p.x) - rot;
      float angle_seg = 6.28318530718 / sides;
      float half_seg = angle_seg / 2.0;
      float theta_mod = mod(theta, angle_seg);
      float r_bound = r * cos(half_seg) / cos(theta_mod - half_seg);
      return d <= r_bound;
    }

    vec3 getBokehBlur(vec2 uv, float radius, float sides, float rotation_deg, float boost_strength) {
      if (radius <= 0.0) return getProcessedColor(uv);
      vec2 step = vec2(radius) / u_resolution;
      vec3 sum = vec3(0.0);
      float totalWeight = 0.0;
      float rot = rotation_deg * 0.01745329251;
      
      for (float y = -3.0; y <= 3.0; y += 1.0) {
        for (float x = -3.0; x <= 3.0; x += 1.0) {
          vec2 offset = vec2(x, y) / 3.0;
          if (inPolygon(offset * radius, radius, sides, rot)) {
            vec2 sampleUV = uv + offset * step;
            vec3 sampleColor = getProcessedColor(clamp(sampleUV, 0.0, 1.0));
            float luma = dot(sampleColor, vec3(0.299, 0.587, 0.114));
            // Boost bright pixels
            float boost = 1.0 + boost_strength * pow(max(0.0, luma - 0.6) / 0.4, 2.0) * 12.0;
            sum += sampleColor * boost;
            totalWeight += boost;
          }
        }
      }
      return totalWeight > 0.0 ? sum / totalWeight : getProcessedColor(uv);
    }

    vec3 getPixelSorting(vec2 uv, float threshold, float seed) {
      float dir = mod(seed, 2.0);
      vec2 step = (dir == 0.0) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      step /= u_resolution;
      
      vec3 col = getProcessedColor(uv);
      float currentLuma = dot(col, vec3(0.299, 0.587, 0.114));
      if (currentLuma <= threshold) {
        return col;
      }
      
      float start_offset = 0.0;
      bool found_start = false;
      for (float i = 1.0; i <= 15.0; i += 1.0) {
        if (!found_start) {
          vec2 sampleUV = uv - i * step;
          if (sampleUV.x < 0.0 || sampleUV.y < 0.0 || sampleUV.x > 1.0 || sampleUV.y > 1.0) {
            start_offset = -(i - 1.0);
            found_start = true;
          } else {
            vec3 c = getProcessedColor(sampleUV);
            float l = dot(c, vec3(0.299, 0.587, 0.114));
            if (l <= threshold) {
              start_offset = -(i - 1.0);
              found_start = true;
            } else {
              start_offset = -i;
            }
          }
        }
      }
      
      float end_offset = 0.0;
      bool found_end = false;
      for (float i = 1.0; i <= 15.0; i += 1.0) {
        if (!found_end) {
          vec2 sampleUV = uv + i * step;
          if (sampleUV.x < 0.0 || sampleUV.y < 0.0 || sampleUV.x > 1.0 || sampleUV.y > 1.0) {
            end_offset = i - 1.0;
            found_end = true;
          } else {
            vec3 c = getProcessedColor(sampleUV);
            float l = dot(c, vec3(0.299, 0.587, 0.114));
            if (l <= threshold) {
              end_offset = i - 1.0;
              found_end = true;
            } else {
              end_offset = i;
            }
          }
        }
      }
      
      float segmentLength = end_offset - start_offset + 1.0;
      if (segmentLength <= 1.0) {
        return col;
      }
      
      float current_idx = -start_offset;
      vec3 resultColor = col;
      
      for (float i = -15.0; i <= 15.0; i += 1.0) {
        if (i >= start_offset && i <= end_offset) {
          vec2 i_uv = uv + i * step;
          vec3 i_col = getProcessedColor(i_uv);
          float i_luma = dot(i_col, vec3(0.299, 0.587, 0.114));
          
          float i_rank = 0.0;
          for (float j = -15.0; j <= 15.0; j += 1.0) {
            if (j >= start_offset && j <= end_offset) {
              if (i != j) {
                vec2 j_uv = uv + j * step;
                vec3 j_col = getProcessedColor(j_uv);
                float j_luma = dot(j_col, vec3(0.299, 0.587, 0.114));
                
                if (j_luma < i_luma) {
                  i_rank += 1.0;
                } else if (j_luma == i_luma && j < i) {
                  i_rank += 1.0;
                }
              }
            }
          }
          
          if (abs(i_rank - current_idx) < 0.5) {
            resultColor = i_col;
          }
        }
      }
      
      return resultColor;
    }

    void main() {
      vec2 uv = v_texCoord;
      
      // Glass Prism UV distortions
      if (u_prism_enabled && u_prism_intensity > 0.0) {
        if (u_prism_mode == 1) { // Kaleidoscope
          vec2 d = uv - 0.5;
          float r = length(d);
          float theta = atan(d.y, d.x);
          float segments = 8.0;
          float segment_angle = 2.0 * 3.14159265 / segments;
          float theta_mapped = mod(theta, segment_angle);
          float half_angle = segment_angle / 2.0;
          float theta_mirror = half_angle - abs(theta_mapped - half_angle);
          float theta_final = mix(theta, theta_mirror, u_prism_intensity);
          uv = vec2(cos(theta_final), sin(theta_final)) * r + 0.5;
        }
        else if (u_prism_mode == 3) { // Refraction Ring
          vec2 d = uv - 0.5;
          float r = length(d);
          float max_r = 0.7071;
          float ring_center = max_r * 0.6;
          float ring_width = max_r * 0.15 * u_prism_intensity;
          float mask = clamp(1.0 - abs(r - ring_center) / max(1e-4, ring_width), 0.0, 1.0);
          float dist_norm = sin(mask * 3.14159265) * (25.0 / u_resolution.x) * u_prism_intensity;
          float r_new = r + dist_norm;
          float theta = atan(d.y, d.x);
          uv = vec2(cos(theta), sin(theta)) * r_new + 0.5;
        }
      }
      
      // 1. Lens Distortion & Chromatic Aberration
      vec2 centerNorm = uv - 0.5;
      float r2 = dot(centerNorm, centerNorm);
      float distFactor = 1.0 + u_distortion * r2;
      if (abs(distFactor) < 1e-4) distFactor = 1e-4;
      vec2 distortedUV = (centerNorm / distFactor) + 0.5;

      float shift = u_chromatic_aberration * 0.008 * r2;
      
      vec4 baseColor;
      if (u_prism_enabled && u_prism_intensity > 0.0 && u_prism_mode == 4) { // Chromatic Edge Dispersion
        float theta = atan(centerNorm.y, centerNorm.x);
        float r = length(centerNorm);
        float max_r = 0.7071;
        float r_shift = 0.05 * u_prism_intensity * (r / max_r);
        float b_shift = -0.05 * u_prism_intensity * (r / max_r);
        
        vec2 uv_r = vec2(cos(theta), sin(theta)) * (r * (1.0 + r_shift)) + 0.5;
        vec2 uv_b = vec2(cos(theta), sin(theta)) * (r * (1.0 + b_shift)) + 0.5;
        
        float rVal = texture2D(u_texture, uv_r).r;
        float gVal = texture2D(u_texture, uv).g;
        float bVal = texture2D(u_texture, uv_b).b;
        baseColor = vec4(rVal, gVal, bVal, 1.0);
      }
      else if (u_chromatic_aberration != 0.0 || u_distortion != 0.0) {
        vec2 shiftVec;
        if (u_aberration_radial) {
          shiftVec = shift * centerNorm;
        } else {
          shiftVec = vec2(u_chromatic_aberration * 0.003, 0.0);
        }
        float rVal = texture2D(u_texture, distortedUV - shiftVec).r;
        float gVal = texture2D(u_texture, distortedUV).g;
        float bVal = texture2D(u_texture, distortedUV + shiftVec).b;
        baseColor = vec4(rVal, gVal, bVal, 1.0);
      } else {
        baseColor = texture2D(u_texture, uv);
      }

      vec3 origColor = baseColor.rgb;
      vec3 color = origColor;

      // Triple Split Prism overlay
      if (u_prism_enabled && u_prism_intensity > 0.0 && u_prism_mode == 2) {
        float shiftPrism = 0.12 * u_prism_intensity;
        vec3 colLeft = texture2D(u_texture, uv - vec2(shiftPrism, 0.0)).rgb;
        vec3 colRight = texture2D(u_texture, uv + vec2(shiftPrism, 0.0)).rgb;
        float opacity = 0.3 * u_prism_intensity;
        color = color * (1.0 - opacity * 2.0) + colLeft * opacity + colRight * opacity;
      }

      // 3. White Balance Gains
      color *= u_wb_gains;
      color = clamp(color, 0.0, 1.0);

      // 4. Predefined LUT Looks
      if (u_lut_intensity > 0.0 && u_lut_look != 0) {
        vec3 lutColor = color;
        float luma = dot(lutColor, vec3(0.299, 0.587, 0.114));
        
        if (u_lut_look == 1) { // Teal & Orange
          float sMask = clamp((0.5 - luma) * 2.0, 0.0, 1.0);
          lutColor.r -= u_lut_intensity * 0.08 * sMask;
          lutColor.g += u_lut_intensity * 0.05 * sMask;
          lutColor.b += u_lut_intensity * 0.15 * sMask;
          float hMask = clamp((luma - 0.5) * 2.0, 0.0, 1.0);
          lutColor.r += u_lut_intensity * 0.15 * hMask;
          lutColor.g += u_lut_intensity * 0.06 * hMask;
          lutColor.b -= u_lut_intensity * 0.10 * hMask;
        } 
        else if (u_lut_look == 2) { // Kodak Portra
          lutColor.r *= (1.0 + u_lut_intensity * 0.05);
          lutColor.b *= (1.0 - u_lut_intensity * 0.05);
          lutColor = mix(lutColor, vec3(luma), u_lut_intensity * 0.15);
          lutColor = (lutColor - 0.5) * (1.0 - u_lut_intensity * 0.08) + 0.5;
        } 
        else if (u_lut_look == 3) { // Fuji Superia
          float sMask = clamp((0.45 - luma) * 2.2, 0.0, 1.0);
          lutColor.r += u_lut_intensity * 0.04 * sMask;
          lutColor.b += u_lut_intensity * 0.08 * sMask;
          lutColor.g *= (1.0 + u_lut_intensity * 0.08);
          lutColor.r *= (1.0 + u_lut_intensity * 0.06);
        } 
        else if (u_lut_look == 4) { // Monochrome Noir
          vec3 noir = vec3(lutColor.r * 0.60 + lutColor.g * 0.35 + lutColor.b * 0.05);
          noir = clamp((noir - 0.45) * (1.0 + u_lut_intensity * 0.5) + 0.45, 0.0, 1.0);
          lutColor = mix(lutColor, noir, u_lut_intensity);
        } 
        else if (u_lut_look == 5) { // Vintage Gold
          float factor = 1.0 - u_lut_intensity * 0.08;
          lutColor = lutColor * factor + u_lut_intensity * 0.08;
          lutColor.r *= (1.0 + u_lut_intensity * 0.12);
          lutColor.g *= (1.0 + u_lut_intensity * 0.08);
          lutColor.b *= (1.0 - u_lut_intensity * 0.12);
          lutColor = mix(lutColor, vec3(luma), u_lut_intensity * 0.20);
        } 
        else if (u_lut_look == 6) { // Cyberpunk
          float sMask = clamp((0.5 - luma) * 2.0, 0.0, 1.0);
          lutColor.r += u_lut_intensity * 0.16 * sMask;
          lutColor.b += u_lut_intensity * 0.16 * sMask;
          lutColor.g -= u_lut_intensity * 0.08 * sMask;
          float hMask = clamp((luma - 0.5) * 2.0, 0.0, 1.0);
          lutColor.r -= u_lut_intensity * 0.12 * hMask;
          lutColor.g += u_lut_intensity * 0.16 * hMask;
          lutColor.b += u_lut_intensity * 0.16 * hMask;
        }
        color = clamp(lutColor, 0.0, 1.0);
      }

      // 5. Tone Adjust
      if (u_brightness != 1.0) {
        color *= u_brightness;
      }
      if (u_contrast != 1.0) {
        color = (color - 0.5) * u_contrast + 0.5;
      }
      
      float luma = dot(color, vec3(0.299, 0.587, 0.114));

      if (u_light_balance != 0.0) {
        float midMask = 1.0 - abs(luma - 0.5) * 2.0;
        color += u_light_balance * 0.10 * midMask;
      }
      if (u_highlights != 0.0) {
        float hMask = clamp((luma - 0.5) * 2.0, 0.0, 1.0);
        color += (u_highlights * 0.18 * hMask) * (1.0 - color);
      }
      if (u_shadows != 0.0) {
        float sMask = clamp((0.5 - luma) * 2.0, 0.0, 1.0);
        color += (u_shadows * 0.18 * sMask) * (1.0 - color);
      }
      if (u_warmth != 0.0) {
        color.r *= (1.0 + u_warmth * 0.16);
        color.g *= (1.0 + u_warmth * 0.03);
        color.b *= (1.0 - u_warmth * 0.16);
      }
      color = clamp(color, 0.0, 1.0);

      // 6. Saturation & Vibrance
      luma = dot(color, vec3(0.299, 0.587, 0.114));
      if (u_saturation != 0.0) {
        color = clamp(luma + (color - luma) * (1.0 + u_saturation), 0.0, 1.0);
      }
      if (u_vibrance != 0.0) {
        float cmax = max(color.r, max(color.g, color.b));
        float cmin = min(color.r, min(color.g, color.b));
        float s = cmax > 1e-6 ? (cmax - cmin) / cmax : 0.0;
        float vf = 1.0 + u_vibrance * (1.0 - s);
        color = clamp(luma + (color - luma) * vf, 0.0, 1.0);
      }

      // 7. Tone Curves (v6.0)
      if (u_curves_enabled) {
        color.r = texture2D(u_curveTexture, vec2(color.r, 0.5)).r;
        color.g = texture2D(u_curveTexture, vec2(color.g, 0.5)).g;
        color.b = texture2D(u_curveTexture, vec2(color.b, 0.5)).b;
        
        color.r = texture2D(u_curveTexture, vec2(color.r, 0.5)).a;
        color.g = texture2D(u_curveTexture, vec2(color.g, 0.5)).a;
        color.b = texture2D(u_curveTexture, vec2(color.b, 0.5)).a;
      }

      // 9b. Split Toning
      if (u_split_toning_enabled) {
        float l = color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
        float luma_shifted = clamp(l - u_split_balance * 0.2, 0.0, 1.0);
        float highlight_mask = luma_shifted * luma_shifted;
        float shadow_mask = (1.0 - luma_shifted) * (1.0 - luma_shifted);
        
        vec3 shadow_tint = color * u_split_shadow_color;
        vec3 highlight_tint = color * u_split_highlight_color;
        
        vec3 blended = color;
        blended = mix(blended, shadow_tint, shadow_mask);
        blended = mix(blended, highlight_tint, highlight_mask);
        
        float luma_new = blended.r * 0.299 + blended.g * 0.587 + blended.b * 0.114;
        float luma_ratio = luma_new > 1e-5 ? l / luma_new : 1.0;
        color = clamp(blended * luma_ratio, 0.0, 1.0);
      }

      // 9c. Gradient Map
      if (u_gradient_map_enabled) {
        float l = color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
        vec3 mapped = color;
        if (u_gradient_preset == 1) {
          mapped = evalGradient3(l, vec3(0.07, 0.05, 0.18), vec3(0.87, 0.25, 0.2), vec3(1.0, 0.77, 0.35));
        } else if (u_gradient_preset == 2) {
          mapped = evalGradient3(l, vec3(0.05, 0.08, 0.05), vec3(0.35, 0.45, 0.25), vec3(0.9, 0.92, 0.8));
        } else if (u_gradient_preset == 3) {
          mapped = evalGradient3(l, vec3(0.05, 0.0, 0.15), vec3(0.9, 0.0, 0.5), vec3(0.0, 0.95, 1.0));
        } else if (u_gradient_preset == 4) {
          mapped = evalGradient3(l, vec3(0.12, 0.07, 0.05), vec3(0.68, 0.52, 0.35), vec3(0.95, 0.92, 0.85));
        } else if (u_gradient_preset == 5) {
          mapped = evalGradient2(l, vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0));
        }
        color = mix(color, mapped, u_gradient_intensity);
      }

      // 9. Vignette
      float radius = length(centerNorm);
      float innerMask = clamp(1.0 - radius, 0.0, 1.0);
      innerMask = innerMask * innerMask * (3.0 - 2.0 * innerMask); // smoothstep
      float outerMask = 1.0 - innerMask;
      float vignetteGain = outerMask * (1.0 + u_outer_brightness) + innerMask * (1.0 + u_inner_brightness);
      color *= vignetteGain;
      color = clamp(color, 0.0, 1.0);
      luma = dot(color, vec3(0.299, 0.587, 0.114));

      // 9.5. Portrait Bokeh
      if (u_portrait_bokeh_enabled) {
        float maskVal = 1.0;
        
        if (u_bokeh_mask_mode == 3) { // none: full image blur
          maskVal = 0.0;
        } else if (u_bokeh_mask_mode == 0) { // auto: AI mask texture
          if (u_has_subject_mask) {
            maskVal = texture2D(u_subject_mask_texture, uv).r;
          } else {
            maskVal = 1.0; // No mask yet: keep sharp, do NOT blur
          }
        } else if (u_bokeh_mask_mode == 1) { // radial: radial focus mask
          vec2 center = vec2(u_bokeh_mask_center_x / 100.0, u_bokeh_mask_center_y / 100.0);
          vec2 delta = uv - center;
          delta.x *= u_resolution.x / u_resolution.y;
          float dist = length(delta);
          
          float max_dim = max(u_resolution.x, u_resolution.y);
          float rad_val = (u_bokeh_mask_radius / 100.0) * (max_dim / u_resolution.y) * 0.5;
          float transition = max(0.01, u_bokeh_mask_hardness);
          float edge0 = rad_val * (1.0 - transition);
          float edge1 = rad_val * (1.0 + transition);
          
          maskVal = 1.0 - smoothstep(edge0, edge1, dist);
        } else if (u_bokeh_mask_mode == 2) { // linear: tilt-shift linear focus mask
          vec2 center = vec2(u_bokeh_mask_center_x / 100.0, u_bokeh_mask_center_y / 100.0);
          float rad_angle = u_bokeh_mask_angle * 0.01745329251;
          vec2 norm = vec2(cos(rad_angle), sin(rad_angle));
          
          vec2 delta = uv - center;
          delta.x *= u_resolution.x / u_resolution.y;
          float dist = abs(dot(delta, norm));
          
          float max_dim = max(u_resolution.x, u_resolution.y);
          float width_val = (u_bokeh_mask_radius / 100.0) * (max_dim / u_resolution.y) * 0.5;
          float transition = max(0.01, u_bokeh_mask_hardness);
          float edge0 = width_val * (1.0 - transition);
          float edge1 = width_val * (1.0 + transition);
          
          maskVal = 1.0 - smoothstep(edge0, edge1, dist);
        }
        
        if (maskVal < 1.0) {
          vec3 blurred = getBokehBlur(uv, max(0.0, u_bokeh_radius), u_bokeh_sides, u_bokeh_rotation, u_bokeh_boost);
          color = mix(blurred, color, maskVal);
          color = clamp(color, 0.0, 1.0);
          luma = dot(color, vec3(0.299, 0.587, 0.114));
        }
      }

      // 10. Style FX
      if (u_style_mode != 0 && u_style_strength > 0.0) {
        if (u_style_mode == 1) { // Bloom
          float bloomMask = getBlurBloomHighlight(uv, max(0.1, u_style_radius * (0.8 + u_style_strength)), u_style_threshold);
          vec3 glow = getBlur(uv, max(0.1, u_style_radius * 1.15));
          color = color * (1.0 - 0.20 * u_style_strength) + glow * bloomMask * (0.35 + 0.65 * u_style_strength);
          color += vec3(bloomMask * (0.05 + 0.08 * u_style_strength));
          color = clamp(color, 0.0, 1.0);
        }
        else if (u_style_mode == 2) { // SoftPortrait
          float blurRadius = max(0.1, u_style_radius * (0.55 + u_style_strength * 0.9));
          vec3 blurred = getBlur(uv, blurRadius);
          
          float sat = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
          float smoothMask = clamp(1.0 - sat * 2.2, 0.0, 1.0) * clamp(1.0 - abs(luma - 0.5) * 1.6, 0.0, 1.0);
          smoothMask = clamp(smoothMask * (0.35 + u_style_strength * 0.9), 0.0, 1.0);
          
          float shadowMask = clamp(0.5 - luma, 0.0, 1.0);
          vec3 lifted = color + (0.03 + u_style_strength * 0.04) * shadowMask;
          lifted.r *= (1.0 + u_style_strength * 0.03);
          lifted.g *= (1.0 + u_style_strength * 0.01);
          lifted.b *= (1.0 - u_style_strength * 0.02);
          
          color = mix(color, blurred, smoothMask);
          color = clamp(color * 0.88 + lifted * 0.12, 0.0, 1.0);
        } 
        else if (u_style_mode == 3) { // CinematicGrade
          float contrastFactor = 1.0 + 0.22 * u_style_strength;
          vec3 cinColor = clamp((color - 0.5) * contrastFactor + 0.5, 0.0, 1.0);
          float cinLuma = dot(cinColor, vec3(0.299, 0.587, 0.114));
          float shadow = clamp((0.5 - cinLuma) * 2.0, 0.0, 1.0);
          float highlight = clamp((cinLuma - 0.5) * 2.0, 0.0, 1.0);
          
          cinColor.r *= (1.0 + 0.10 * u_style_strength * highlight);
          cinColor.g *= (1.0 + 0.02 * u_style_strength * highlight);
          cinColor.b *= (1.0 - 0.08 * u_style_strength * highlight);
          
          cinColor.r *= (1.0 - 0.07 * u_style_strength * shadow);
          cinColor.g *= (1.0 + 0.05 * u_style_strength * shadow);
          cinColor.b *= (1.0 + 0.11 * u_style_strength * shadow);
          
          color = cinColor * (1.0 - 0.10 * u_style_strength);
        }
        else if (u_style_mode == 4) { // Halation
          float haloMask = getBlurHighlight(uv, max(0.1, u_style_radius * (0.7 + u_style_strength)), u_style_threshold);
          vec3 glow = getBlur(uv, max(0.1, u_style_radius));
          color = color + glow * haloMask * (0.18 + 0.55 * u_style_strength);
          color.r += haloMask * (0.08 + 0.18 * u_style_strength);
          color.g += haloMask * (0.03 + 0.05 * u_style_strength);
          color = clamp(color, 0.0, 1.0);
        }
        else if (u_style_mode == 5) { // RetroFilm
          float retroLuma = dot(color, vec3(0.299, 0.587, 0.114));
          float hMask = clamp((retroLuma - 0.4) * 1.66, 0.0, 1.0);
          color.r += u_style_strength * 0.15 * hMask;
          color.g += u_style_strength * 0.07 * hMask;
          color.b -= u_style_strength * 0.08 * hMask;
          
          float sMask = clamp((0.6 - retroLuma) * 1.66, 0.0, 1.0);
          color.r -= u_style_strength * 0.05 * sMask;
          color.b += u_style_strength * 0.12 * sMask;
          
          color = color * 0.95 + 0.03 * u_style_strength;
          
          float leakGrad = uv.x;
          if (mod(u_style_seed, 2.0) == 0.0) {
            leakGrad = 1.0 - uv.x;
          }
          leakGrad = pow(clamp(leakGrad, 0.0, 1.0), 3.5);
          color.r += u_style_strength * 0.35 * leakGrad;
          color.g += u_style_strength * 0.12 * leakGrad;
        }
        else if (u_style_mode == 6) { // Duotone
          vec3 duoColor = vec3(color.r * 0.299 + color.g * 0.587 + color.b * 0.114);
          vec3 lowTone = vec3(0.05, 0.05, 0.25);
          vec3 highTone = vec3(0.95, 0.75, 0.25);
          vec3 blendedDuo = mix(lowTone, highTone, duoColor);
          color = mix(color, blendedDuo, u_style_strength);
        }
        else if (u_style_mode == 7) { // Matte
          float lift = 0.12 * u_style_strength;
          color = lift + (1.0 - lift) * color;
          color *= (1.0 - 0.08 * u_style_strength);
          color = (color - 0.5) * (1.0 - 0.15 * u_style_strength) + 0.5;
        }
        else if (u_style_mode == 8) { // GlitchArt
          float glitchShift = rand(vec2(floor(uv.y * (10.0 + u_style_strength * 15.0)), u_style_seed));
          if (abs(glitchShift) > 0.35) {
            vec2 shiftUV = uv + vec2(glitchShift * u_style_strength * 0.04, 0.0);
            color = texture2D(u_texture, fract(shiftUV)).rgb;
          }
        }
        else if (u_style_mode == 9) { // BokehBlur
          float sides = floor(3.0 + u_style_threshold * 5.0);
          color = getBokehBlur(uv, max(0.0, u_style_radius), sides, u_style_seed, 0.0);
        }
        else if (u_style_mode == 10) { // PixelSorting
          color = getPixelSorting(uv, u_style_threshold, u_style_seed);
        }
      }

      // 10.5. Style Match (CIELAB Reinhard Transfer)
      if (u_style_transfer_enabled && u_style_transfer_intensity > 0.0) {
        vec3 lab = rgb2lab(color);
        vec3 transfer;
        transfer.x = (lab.x - u_style_transfer_mean_src.x) * (u_style_transfer_std_ref.x / max(u_style_transfer_std_src.x, 1e-4)) + u_style_transfer_mean_ref.x;
        transfer.y = (lab.y - u_style_transfer_mean_src.y) * (u_style_transfer_std_ref.y / max(u_style_transfer_std_src.y, 1e-4)) + u_style_transfer_mean_ref.y;
        transfer.z = (lab.z - u_style_transfer_mean_src.z) * (u_style_transfer_std_ref.z / max(u_style_transfer_std_src.z, 1e-4)) + u_style_transfer_mean_ref.z;
        transfer = clamp(transfer, 0.0, 255.0);
        vec3 transferRGB = lab2rgb(transfer);
        color = mix(color, transferRGB, u_style_transfer_intensity);
      }

      // 11. Creative FX
      // A. Infrared Film
      if (u_infrared_enabled && u_infrared_intensity > 0.0) {
        vec3 ir;
        ir.r = clamp(color.r * 0.15 + color.g * 1.5 - color.b * 0.25, 0.0, 1.0);
        ir.g = clamp(color.r * 0.85 + color.g * 0.0 + color.b * 0.15, 0.0, 1.0);
        ir.b = clamp(color.r * -0.25 + color.g * 0.15 + color.b * 1.1, 0.0, 1.0);
        color = mix(color, ir, u_infrared_intensity);
      }

      // B. Light Leaks (unrolled for maximum compatibility)
      if (u_light_leaks_enabled && u_light_leaks_intensity > 0.0) {
        vec3 leakOverlay = vec3(0.0);
        
        { // Leak 0
          float cx = u_leak_centers_x[0];
          float cy = u_leak_centers_y[0];
          float rx = u_leak_radius_x[0];
          float ry = u_leak_radius_y[0];
          vec3 col = u_leak_colors[0];
          float str = u_leak_strength[0];
          
          float dx = (uv.x - cx) / rx;
          float dy = (uv.y - cy) / ry;
          float dist = sqrt(dx * dx + dy * dy);
          
          float falloff = clamp(1.0 - dist, 0.0, 1.0);
          falloff = falloff * falloff * (3.0 - 2.0 * falloff);
          leakOverlay += falloff * col * str;
        }
        
        { // Leak 1
          float cx = u_leak_centers_x[1];
          float cy = u_leak_centers_y[1];
          float rx = u_leak_radius_x[1];
          float ry = u_leak_radius_y[1];
          vec3 col = u_leak_colors[1];
          float str = u_leak_strength[1];
          
          float dx = (uv.x - cx) / rx;
          float dy = (uv.y - cy) / ry;
          float dist = sqrt(dx * dx + dy * dy);
          
          float falloff = clamp(1.0 - dist, 0.0, 1.0);
          falloff = falloff * falloff * (3.0 - 2.0 * falloff);
          leakOverlay += falloff * col * str;
        }
        
        { // Leak 2
          float cx = u_leak_centers_x[2];
          float cy = u_leak_centers_y[2];
          float rx = u_leak_radius_x[2];
          float ry = u_leak_radius_y[2];
          vec3 col = u_leak_colors[2];
          float str = u_leak_strength[2];
          
          float dx = (uv.x - cx) / rx;
          float dy = (uv.y - cy) / ry;
          float dist = sqrt(dx * dx + dy * dy);
          
          float falloff = clamp(1.0 - dist, 0.0, 1.0);
          falloff = falloff * falloff * (3.0 - 2.0 * falloff);
          leakOverlay += falloff * col * str;
        }
        
        color = 1.0 - (1.0 - color) * (1.0 - leakOverlay * u_light_leaks_intensity);
      }

      // C. Graffiti Stencil
      if (u_stencil_enabled) {
        float lumaStencil = dot(color, vec3(0.299, 0.587, 0.114));
        vec2 stepStencil = vec2(1.0) / u_resolution;
        float lumaRight = dot(getProcessedColor(uv + vec2(stepStencil.x, 0.0)), vec3(0.299, 0.587, 0.114));
        float lumaDown  = dot(getProcessedColor(uv + vec2(0.0, stepStencil.y)), vec3(0.299, 0.587, 0.114));
        
        float diffX = abs(lumaRight - lumaStencil);
        float diffY = abs(lumaDown - lumaStencil);
        bool isEdge = (diffX + diffY) > 0.08;
        
        float t1 = u_stencil_threshold * 0.6;
        float t2 = u_stencil_threshold * 1.3;
        
        int level = 0;
        if (lumaStencil >= t1) level = 1;
        if (lumaStencil >= t2) level = 2;
        
        int levelRight = 0;
        if (lumaRight >= t1) levelRight = 1;
        if (lumaRight >= t2) levelRight = 2;
        
        int levelDown = 0;
        if (lumaDown >= t1) levelDown = 1;
        if (lumaDown >= t2) levelDown = 2;
        
        bool isBoundary = (levelRight != level) || (levelDown != level);
        
        if (u_stencil_spray > 0.0 && isBoundary) {
          float nVal = rand(uv + vec2(u_style_seed * 0.13, 0.77)) + 0.5;
          if (nVal < u_stencil_spray * 0.7) {
            float nVal2 = rand(uv + vec2(u_style_seed * 0.29, 0.43));
            if (nVal2 < -0.16) {
              level = level - 1;
              if (level < 0) level = 0;
            } else if (nVal2 > 0.16) {
              level = level + 1;
              if (level > 2) level = 2;
            }
          }
        }
        
        vec3 c_shadow;
        vec3 c_midtone;
        vec3 c_highlight;
        
        if (u_stencil_mode == 1) { // Classic Red/Black
          c_shadow = vec3(0.02, 0.02, 0.02);
          c_midtone = vec3(0.82, 0.12, 0.15);
          c_highlight = vec3(0.94, 0.92, 0.88);
        } else if (u_stencil_mode == 2) { // Cyber Neon
          c_shadow = vec3(0.10, 0.02, 0.15);
          c_midtone = vec3(1.00, 0.00, 0.50);
          c_highlight = vec3(0.00, 0.95, 1.00);
        } else { // High-Contrast B&W
          c_shadow = vec3(0.00, 0.00, 0.00);
          c_midtone = vec3(0.25, 0.25, 0.25);
          c_highlight = vec3(1.00, 1.00, 1.00);
        }
        
        vec3 stencilColor = c_shadow;
        if (level == 1) stencilColor = c_midtone;
        else if (level == 2) stencilColor = c_highlight;
        
        if (isEdge) {
          stencilColor *= 0.1;
        }
        color = stencilColor;
      }

      // 12. Noise
      if (u_noise_level > 0.0) {
        float nR = rand(uv * 1.0 + vec2(u_style_seed * 0.05, 0.1)) * u_noise_level;
        float nG = rand(uv * 2.0 + vec2(u_style_seed * 0.12, 0.2)) * u_noise_level;
        float nB = rand(uv * 3.0 + vec2(u_style_seed * 0.19, 0.3)) * u_noise_level * u_blue_bias;
        color += vec3(nR, nG, nB);
      }

      // Edge Softness blur approximation (vignette style blur)
      if (u_edge_softness > 0.0) {
        float blurMask = clamp(1.0 - r2 * (0.55 + u_edge_softness), 0.0, 1.0);
        color *= mix(0.7, 1.0, blurMask);
      }

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `;

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Could not compile WebGL shader: ' + info);
    }
    return shader;
  }

  return {
    isSupported: function () {
      try {
        const testCanvas = document.createElement('canvas');
        return !!(window.WebGLRenderingContext && 
          (testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl')));
      } catch (e) {
        return false;
      }
    },

    init: function (canvasElement) {
      canvas = canvasElement;
      gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) {
        throw new Error('WebGL not supported');
      }

      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

      // Compile Shaders
      const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
      const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);

      program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error('Could not link WebGL program: ' + gl.getProgramInfoLog(program));
      }

      gl.useProgram(program);

      // Create Quad Geometry
      const positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1.0, -1.0,
         1.0, -1.0,
        -1.0,  1.0,
        -1.0,  1.0,
         1.0, -1.0,
         1.0,  1.0,
      ]), gl.STATIC_DRAW);

      const positionLocation = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      const texCoordBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        0.0,  0.0,
        1.0,  0.0,
        0.0,  1.0,
        0.0,  1.0,
        1.0,  0.0,
        1.0,  1.0,
      ]), gl.STATIC_DRAW);

      const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord');
      gl.enableVertexAttribArray(texCoordLocation);
      gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

      // Create textures
      sourceTexture = gl.createTexture();
      curveTexture = gl.createTexture();
      
      // Bind texture unit 1 for curves
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, curveTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      // Set texture unit 0 for main image
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      // Set texture unit 2 for subject mask
      subjectMaskTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, subjectMaskTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    },

    setImage: function (imageElement) {
      if (!gl) return;
      imageWidth = imageElement.naturalWidth || imageElement.width;
      imageHeight = imageElement.naturalHeight || imageElement.height;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageElement);
      hasSubjectMask = false;
    },

    setSubjectMask: function (maskElement) {
      if (!gl || !subjectMaskTexture) return;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, subjectMaskTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskElement);
      hasSubjectMask = true;
    },

      render: function (params, curves) {
      if (!gl || !program) return;

      // Update curves texture if enabled
      if (params.curves_enabled && curves) {
        const cData = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) {
          cData[i * 4]     = curves.red ? curves.red[i] : i;
          cData[i * 4 + 1] = curves.green ? curves.green[i] : i;
          cData[i * 4 + 2] = curves.blue ? curves.blue[i] : i;
          cData[i * 4 + 3] = curves.rgb ? curves.rgb[i] : i;
        }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, curveTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, cData);
      }

      gl.useProgram(program);

      // Bind texture locations
      gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'u_curveTexture'), 1);

      // Pass Tone Adjust Uniforms
      gl.uniform1f(gl.getUniformLocation(program, 'u_brightness'), parseFloat(params.brightness) ?? 1.16);
      gl.uniform1f(gl.getUniformLocation(program, 'u_contrast'), parseFloat(params.contrast) ?? 1.01);
      gl.uniform1f(gl.getUniformLocation(program, 'u_light_balance'), parseFloat(params.light_balance) ?? 0.36);
      gl.uniform1f(gl.getUniformLocation(program, 'u_highlights'), parseFloat(params.highlights) ?? 0.53);
      gl.uniform1f(gl.getUniformLocation(program, 'u_shadows'), parseFloat(params.shadows) ?? -0.02);
      gl.uniform1f(gl.getUniformLocation(program, 'u_warmth'), parseFloat(params.warmth) ?? 0.04);

      // Saturation / Vibrance
      const satEnabled = params.saturation_enabled !== false && params.saturation_enabled !== 'false';
      gl.uniform1f(gl.getUniformLocation(program, 'u_saturation'), satEnabled ? (parseFloat(params.saturation) || 0) : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_vibrance'), satEnabled ? (parseFloat(params.vibrance) || 0) : 0);

      // White Balance
      const wbEnabled = params.whitebalance_enabled !== false && params.whitebalance_enabled !== 'false';
      let rNorm = 1.0, gNorm = 1.0, bNorm = 1.0;
      if (wbEnabled) {
        const colorTempK = parseFloat(params.color_temp) || 6500;
        const colorTint = parseFloat(params.color_tint) || 0;
        const wbMode = params.whitebalance_mode || 'manual';

        if (wbMode === 'manual') {
          // Kelvin -> RGB Gains math (D65 normalized)
          function kelvinToRgbGains(kelvin) {
            const t = Math.max(1000, Math.min(40000, kelvin)) / 100.0;
            let rg, gg, bg;
            if (t <= 66) rg = 1.0;
            else rg = Math.max(0, Math.min(1, 329.698727446 * Math.pow(t - 60, -0.1332047592) / 255.0));
            if (t <= 66) gg = Math.max(0, Math.min(1, (99.4708025861 * Math.log(t) - 161.1195681661) / 255.0));
            else gg = Math.max(0, Math.min(1, 288.1221695283 * Math.pow(t - 60, -0.0755148492) / 255.0));
            if (t >= 66) bg = 1.0;
            else if (t <= 19) bg = 0.0;
            else bg = Math.max(0, Math.min(1, (138.5177312231 * Math.log(t - 10) - 305.0447927307) / 255.0));
            return [rg, gg, bg];
          }
          const [rRef, gRef, bRef] = kelvinToRgbGains(6500);
          const [rGain, gGain, bGain] = kelvinToRgbGains(colorTempK);
          rNorm = rGain / Math.max(rRef, 1e-4);
          gNorm = gGain / Math.max(gRef, 1e-4);
          bNorm = bGain / Math.max(bRef, 1e-4);
          rNorm += colorTint < 0 ? -colorTint * 0.10 : 0;
          gNorm += colorTint > 0 ?  colorTint * 0.15 : 0;
          bNorm += colorTint < 0 ? -colorTint * 0.10 : 0;
        }
      }
      gl.uniform3f(gl.getUniformLocation(program, 'u_wb_gains'), rNorm, gNorm, bNorm);

      // Noise and Vignette
      const noiseEnabled = params.noise_enabled !== false && params.noise_enabled !== 'false';
      gl.uniform1f(gl.getUniformLocation(program, 'u_noise_level'), noiseEnabled ? (parseFloat(params.noise_level) ?? 0.02) : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_blue_bias'), parseFloat(params.blue_bias) ?? 0.8);
      
      const vignetteEnabled = params.vignette_enabled !== false && params.vignette_enabled !== 'false';
      gl.uniform1f(gl.getUniformLocation(program, 'u_outer_brightness'), vignetteEnabled ? (parseFloat(params.outer_brightness) ?? 0.05) : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_inner_brightness'), vignetteEnabled ? (parseFloat(params.inner_brightness) ?? 0.20) : 0);

      // Lens Distortion
      const warpEnabled = params.lenswarp_enabled !== false && params.lenswarp_enabled !== 'false';
      gl.uniform1f(gl.getUniformLocation(program, 'u_distortion'), warpEnabled ? (parseFloat(params.distortion) ?? 0.03) : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_chromatic_aberration'), warpEnabled ? (parseFloat(params.chromatic_aberration) ?? 0.10) : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_edge_softness'), warpEnabled ? (parseFloat(params.edge_softness) ?? 0.15) : 0);
      gl.uniform1i(gl.getUniformLocation(program, 'u_aberration_radial'), (warpEnabled && (params.aberration_radial === true || params.aberration_radial === 'true')) ? 1 : 0);

      // Split Toning
      const splitEnabled = params.split_toning_enabled === true || params.split_toning_enabled === 'true';
      gl.uniform1i(gl.getUniformLocation(program, 'u_split_toning_enabled'), splitEnabled ? 1 : 0);
      
      function parseColorToRgb(c) {
        if (!c) return [0.0, 0.0, 0.0];
        c = c.replace('#', '');
        if (c.length === 6) {
          return [
            parseInt(c.substring(0, 2), 16) / 255.0,
            parseInt(c.substring(2, 4), 16) / 255.0,
            parseInt(c.substring(4, 6), 16) / 255.0
          ];
        }
        return [0.0, 0.0, 0.0];
      }
      const shRgb = parseColorToRgb(params.split_shadow_color);
      const hlRgb = parseColorToRgb(params.split_highlight_color);
      gl.uniform3f(gl.getUniformLocation(program, 'u_split_shadow_color'), shRgb[0], shRgb[1], shRgb[2]);
      gl.uniform3f(gl.getUniformLocation(program, 'u_split_highlight_color'), hlRgb[0], hlRgb[1], hlRgb[2]);
      gl.uniform1f(gl.getUniformLocation(program, 'u_split_balance'), parseFloat(params.split_balance) || 0.0);

      // Gradient Map
      const gradEnabled = params.gradient_map_enabled === true || params.gradient_map_enabled === 'true';
      gl.uniform1i(gl.getUniformLocation(program, 'u_gradient_map_enabled'), gradEnabled ? 1 : 0);
      const gradPresets = { "Sunset": 1, "Forest": 2, "Cyberpunk": 3, "Vintage": 4, "B&W": 5 };
      gl.uniform1i(gl.getUniformLocation(program, 'u_gradient_preset'), gradPresets[params.gradient_preset] || 1);
      gl.uniform1f(gl.getUniformLocation(program, 'u_gradient_intensity'), parseFloat(params.gradient_intensity) ?? 1.0);

      // Predefined LUT Looks
      const lutEnabled = params.colorlooks_enabled !== false && params.colorlooks_enabled !== 'false';
      const look = (lutEnabled && params.lut_look) ? params.lut_look : "None";
      const looksMap = {
        "None": 0, "Teal & Orange": 1, "Kodak Portra": 2, "Fuji Superia": 3,
        "Monochrome Noir": 4, "Vintage Gold": 5, "Cyberpunk": 6
      };
      gl.uniform1i(gl.getUniformLocation(program, 'u_lut_look'), looksMap[look] ?? 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_lut_intensity'), lutEnabled ? (parseFloat(params.lut_intensity) ?? 0.0) : 0);

      // Pass Resolution
      gl.uniform2f(gl.getUniformLocation(program, 'u_resolution'), imageWidth || 1000, imageHeight || 1000);

      // Portrait Bokeh Uniform Bindings
      const pbEnabled = params.portrait_bokeh_enabled === true || params.portrait_bokeh_enabled === 'true';
      gl.uniform1i(gl.getUniformLocation(program, 'u_portrait_bokeh_enabled'), pbEnabled ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_bokeh_radius'), pbEnabled ? (parseFloat(params.portrait_bokeh_radius) ?? 20.0) : 0.0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_bokeh_sides'), pbEnabled ? (parseFloat(params.portrait_bokeh_sides) ?? 6.0) : 6.0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_bokeh_rotation'), pbEnabled ? (parseFloat(params.portrait_bokeh_rotation) ?? 0.0) : 0.0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_bokeh_boost'), pbEnabled ? (parseFloat(params.portrait_bokeh_boost) ?? 0.50) : 0.0);

      const pbMaskModes = { 'auto': 0, 'radial': 1, 'linear': 2, 'none': 3 };
      const pbMaskModeStr = params.portrait_bokeh_mask_mode || 'auto';
      gl.uniform1i(gl.getUniformLocation(program, 'u_bokeh_mask_mode'), pbMaskModes[pbMaskModeStr] ?? 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_bokeh_mask_center_x'), parseFloat(params.portrait_bokeh_mask_center_x) ?? 50.0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_bokeh_mask_center_y'), parseFloat(params.portrait_bokeh_mask_center_y) ?? 50.0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_bokeh_mask_radius'), parseFloat(params.portrait_bokeh_mask_radius) ?? 30.0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_bokeh_mask_angle'), parseFloat(params.portrait_bokeh_mask_angle) ?? 0.0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_bokeh_mask_hardness'), parseFloat(params.portrait_bokeh_mask_hardness) ?? 0.50);

      gl.uniform1i(gl.getUniformLocation(program, 'u_subject_mask_texture'), 2);
      gl.uniform1i(gl.getUniformLocation(program, 'u_has_subject_mask'), hasSubjectMask ? 1 : 0);
      if (hasSubjectMask) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, subjectMaskTexture);
      }

      // Style FX
      const styleEnabled = params.stylefx_enabled !== false && params.stylefx_enabled !== 'false';
      const styleMode = (styleEnabled && params.mode) ? params.mode : "Bloom";
      const styleModeMap = {
        "Bloom": 1,
        "SoftPortrait": 2,
        "CinematicGrade": 3,
        "Halation": 4,
        "RetroFilm": 5,
        "Duotone": 6,
        "Matte": 7,
        "GlitchArt": 8,
        "BokehBlur": 9,
        "PixelSorting": 10
      };
      gl.uniform1i(gl.getUniformLocation(program, 'u_style_mode'), styleEnabled ? (styleModeMap[styleMode] ?? 0) : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_style_strength'), styleEnabled ? (parseFloat(params.strength) ?? 0.33) : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_style_radius'), styleEnabled ? (parseFloat(params.radius) ?? 20.7) : 0.0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_style_threshold'), styleEnabled ? (parseFloat(params.threshold) ?? 0.8) : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_style_seed'), parseFloat(params.seed) || 0.0);

      // Style Match (CIELAB Reinhard Transfer)
      const styleTransferEnabled = params.style_transfer_enabled === true || params.style_transfer_enabled === 'true';
      gl.uniform1i(gl.getUniformLocation(program, 'u_style_transfer_enabled'), styleTransferEnabled ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_style_transfer_intensity'), parseFloat(params.style_transfer_intensity) ?? 1.0);
      
      let meanSrc = [128.0, 128.0, 128.0];
      let stdSrc = [30.0, 10.0, 10.0];
      let meanRef = [128.0, 128.0, 128.0];
      let stdRef = [30.0, 10.0, 10.0];
      
      if (styleTransferEnabled) {
        if (params.source_stats) {
          meanSrc = [params.source_stats.l_mean, params.source_stats.a_mean, params.source_stats.b_mean];
          stdSrc = [params.source_stats.l_std, params.source_stats.a_std, params.source_stats.b_std];
        }
        if (params.style_transfer_stats) {
          meanRef = [params.style_transfer_stats.l_mean, params.style_transfer_stats.a_mean, params.style_transfer_stats.b_mean];
          stdRef = [params.style_transfer_stats.l_std, params.style_transfer_stats.a_std, params.style_transfer_stats.b_std];
        }
      }
      gl.uniform3f(gl.getUniformLocation(program, 'u_style_transfer_mean_src'), meanSrc[0], meanSrc[1], meanSrc[2]);
      gl.uniform3f(gl.getUniformLocation(program, 'u_style_transfer_std_src'), stdSrc[0], stdSrc[1], stdSrc[2]);
      gl.uniform3f(gl.getUniformLocation(program, 'u_style_transfer_mean_ref'), meanRef[0], meanRef[1], meanRef[2]);
      gl.uniform3f(gl.getUniformLocation(program, 'u_style_transfer_std_ref'), stdRef[0], stdRef[1], stdRef[2]);

      // Creative FX
      // 1. Infrared Film
      const infraredEnabled = params.infrared_enabled === true || params.infrared_enabled === 'true';
      gl.uniform1i(gl.getUniformLocation(program, 'u_infrared_enabled'), infraredEnabled ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_infrared_intensity'), parseFloat(params.infrared_intensity) ?? 0.8);

      // 2. Glass Prism Refractions
      const prismEnabled = params.prism_enabled === true || params.prism_enabled === 'true';
      gl.uniform1i(gl.getUniformLocation(program, 'u_prism_enabled'), prismEnabled ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_prism_intensity'), parseFloat(params.prism_intensity) ?? 0.5);
      const prismModeMap = {
        "Kaleidoscope": 1,
        "Triple Split": 2,
        "Refraction Ring": 3,
        "Chromatic Edge": 4
      };
      gl.uniform1i(gl.getUniformLocation(program, 'u_prism_mode'), prismModeMap[params.prism_mode] ?? 1);

      // 3. Light Leaks
      const leaksEnabled = params.light_leaks_enabled === true || params.light_leaks_enabled === 'true';
      gl.uniform1i(gl.getUniformLocation(program, 'u_light_leaks_enabled'), leaksEnabled ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_light_leaks_intensity'), parseFloat(params.light_leaks_intensity) ?? 0.5);
      
      // Dynamic leak generation
      function createRandom(seed) {
        let s = seed || 12345;
        return function() {
          let t = s += 0x6D2B79F5;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        }
      }
      const randVal = createRandom(parseInt(params.light_leaks_seed) || 12345);
      const numLeaks = 3;
      const leakCentersX = new Float32Array(numLeaks);
      const leakCentersY = new Float32Array(numLeaks);
      const leakColors = new Float32Array(numLeaks * 3);
      const leakRadiusX = new Float32Array(numLeaks);
      const leakRadiusY = new Float32Array(numLeaks);
      const leakStrength = new Float32Array(numLeaks);
      
      for (let i = 0; i < numLeaks; i++) {
        const edge = Math.floor(randVal() * 4);
        let cx = 0, cy = 0;
        if (edge === 0) {
          cx = randVal() * 0.1;
          cy = randVal();
        } else if (edge === 1) {
          cx = 0.9 + randVal() * 0.1;
          cy = randVal();
        } else if (edge === 2) {
          cx = randVal();
          cy = randVal() * 0.1;
        } else {
          cx = randVal();
          cy = 0.9 + randVal() * 0.1;
        }
        
        const colorType = Math.floor(randVal() * 3);
        let rColor = [1.0, 0.35, 0.05];
        if (colorType === 1) rColor = [1.0, 0.1, 0.4];
        else if (colorType === 2) rColor = [1.0, 0.75, 0.1];
        
        const rx = 0.25 + randVal() * 0.35;
        const ry = 0.25 + randVal() * 0.35;
        const str = 0.6 + randVal() * 0.4;
        
        leakCentersX[i] = cx;
        leakCentersY[i] = cy;
        leakColors[i * 3] = rColor[0];
        leakColors[i * 3 + 1] = rColor[1];
        leakColors[i * 3 + 2] = rColor[2];
        leakRadiusX[i] = rx;
        leakRadiusY[i] = ry;
        leakStrength[i] = str;
      }
      gl.uniform1fv(gl.getUniformLocation(program, 'u_leak_centers_x'), leakCentersX);
      gl.uniform1fv(gl.getUniformLocation(program, 'u_leak_centers_y'), leakCentersY);
      gl.uniform3fv(gl.getUniformLocation(program, 'u_leak_colors'), leakColors);
      gl.uniform1fv(gl.getUniformLocation(program, 'u_leak_radius_x'), leakRadiusX);
      gl.uniform1fv(gl.getUniformLocation(program, 'u_leak_radius_y'), leakRadiusY);
      gl.uniform1fv(gl.getUniformLocation(program, 'u_leak_strength'), leakStrength);

      // 4. Graffiti Stencil
      const stencilEnabled = params.stencil_enabled === true || params.stencil_enabled === 'true';
      gl.uniform1i(gl.getUniformLocation(program, 'u_stencil_enabled'), stencilEnabled ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_stencil_threshold'), parseFloat(params.stencil_threshold) ?? 0.5);
      gl.uniform1f(gl.getUniformLocation(program, 'u_stencil_spray'), parseFloat(params.stencil_spray) ?? 0.3);
      const stencilModeMap = {
        "Classic Red/Black": 1,
        "Cyber Neon": 2,
        "High-Contrast B&W": 3
      };
      gl.uniform1i(gl.getUniformLocation(program, 'u_stencil_mode'), stencilModeMap[params.stencil_mode] ?? 1);

      // Curves enabled state
      gl.uniform1i(gl.getUniformLocation(program, 'u_curves_enabled'), (params.curves_enabled && curves) ? 1 : 0);

      // Draw
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.0, 0.0, 0.0, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  };
})();
