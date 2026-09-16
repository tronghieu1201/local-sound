/* ==========================================================================
   Neon Chasing Heart WebGL Background Animation
   ========================================================================== */

(function () {
    function initBackground() {
        const canvas = document.getElementById("bg-canvas");
        if (!canvas) return;

        let gl = null;
        try {
            gl = canvas.getContext("webgl", { powerPreference: "high-performance", alpha: false, antialias: false }) ||
                 canvas.getContext("experimental-webgl");
        } catch (e) {
            console.warn("WebGL background init warning:", e);
        }

        if (!gl) {
            console.warn("WebGL is not supported by your browser for background.");
            return;
        }

        const vertexSource = `
      attribute vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

        const fragmentSource = `
      precision highp float;

      uniform float width;
      uniform float height;
      uniform float time;

      #define POINT_COUNT 8
      vec2 points[POINT_COUNT];
      const float speed = -0.75;
      const float len = 0.25;
      float intensity = 1.3;
      float radius = 0.0085;

      // Signed distance to a quadratic bezier curve
      float sdBezier(vec2 pos, vec2 A, vec2 B, vec2 C) {    
        vec2 a = B - A;
        vec2 b = A - 2.0 * B + C;
        vec2 c = a * 2.0;
        vec2 d = A - pos;

        float kk = 1.0 / dot(b, b);
        float kx = kk * dot(a, b);
        float ky = kk * (2.0 * dot(a, a) + dot(d, b)) / 3.0;
        float kz = kk * dot(d, a);      

        float res = 0.0;
        float p = ky - kx * kx;
        float p3 = p * p * p;
        float q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
        float h = q * q + 4.0 * p3;

        if (h >= 0.0) { 
          h = sqrt(h);
          vec2 x = (vec2(h, -h) - q) / 2.0;
          vec2 uv = sign(x) * pow(abs(x), vec2(1.0 / 3.0));
          float t = uv.x + uv.y - kx;
          t = clamp(t, 0.0, 1.0);

          vec2 qos = d + (c + b * t) * t;
          res = length(qos);
        } else {
          float z = sqrt(-p);
          float v = acos(clamp(q / (p * z * 2.0), -1.0, 1.0)) / 3.0;
          float m = cos(v);
          float n = sin(v) * 1.732050808;
          vec3 t = vec3(m + m, -n - m, n - m) * z - kx;
          t = clamp(t, 0.0, 1.0);

          vec2 qos = d + (c + b * t.x) * t.x;
          float dis = dot(qos, qos);
          res = dis;

          qos = d + (c + b * t.y) * t.y;
          dis = dot(qos, qos);
          res = min(res, dis);

          qos = d + (c + b * t.z) * t.z;
          dis = dot(qos, qos);
          res = min(res, dis);

          res = sqrt(res);
        }
        return res;
      }

      vec2 getHeartPosition(float t) {
        return vec2(
          16.0 * sin(t) * sin(t) * sin(t),
          -(13.0 * cos(t) - 5.0 * cos(2.0 * t) - 2.0 * cos(3.0 * t) - cos(4.0 * t)) - 2.54
        );
      }

      float getGlow(float dist, float radius, float intensity) {
        return pow(radius / max(dist, 0.0001), intensity);
      }

      float getSegment(float t, vec2 pos, float offset, float scale) {
        for (int i = 0; i < POINT_COUNT; i++) {
          points[i] = getHeartPosition(offset + float(i) * len + fract(speed * t) * 6.28318530718);
        }

        vec2 c = (points[0] + points[1]) / 2.0;
        vec2 c_prev;
        float dist = 10000.0;

        for (int i = 0; i < POINT_COUNT - 1; i++) {
          c_prev = c;
          c = (points[i] + points[i + 1]) / 2.0;
          dist = min(dist, sdBezier(pos, scale * c_prev, scale * points[i], scale * c));
        }
        return max(0.0, dist);
      }

      void main() {
        vec2 resolution = vec2(width, height);
        float minDim = min(resolution.x, resolution.y);
        vec2 pos = (gl_FragCoord.xy - 0.5 * resolution.xy) / minDim;
        pos.y = -pos.y;

        // Zoom 65%: chiều rộng trái tim chiếm đúng 65% kích thước cạnh nhỏ nhất màn hình
        float scale = 0.65 / 32.0;
        float t = time;

        // Vệt hồng
        float distPink = getSegment(t, pos, 0.0, scale);
        float glowPink = getGlow(distPink, radius, intensity);

        vec3 col = vec3(0.0);

        // Lõi trắng siêu sáng
        col += 10.0 * vec3(smoothstep(0.0035, 0.001, distPink));
        // Quầng phát quang OLED Hồng rực rỡ
        col += glowPink * vec3(1.0, 0.05, 0.38);

        // Vệt xanh (đối xứng pha 180 độ)
        float distBlue = getSegment(t, pos, 3.14159265, scale);
        float glowBlue = getGlow(distBlue, radius, intensity);

        // Lõi trắng siêu sáng
        col += 10.0 * vec3(smoothstep(0.0035, 0.001, distBlue));
        // Quầng phát quang OLED Xanh rực rỡ
        col += glowBlue * vec3(0.05, 0.55, 1.0);

        // Tone mapping HDR
        col = 1.0 - exp(-col);

        // Gamma correction
        col = pow(col, vec3(0.4545));

        gl_FragColor = vec4(col, 1.0);
      }
    `;

        function compileShader(shaderSource, shaderType) {
            const shader = gl.createShader(shaderType);
            gl.shaderSource(shader, shaderSource);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.error("Shader compile failed: " + gl.getShaderInfoLog(shader));
                return null;
            }
            return shader;
        }

        function getAttribLocation(prog, name) {
            const loc = gl.getAttribLocation(prog, name);
            if (loc === -1) console.warn("Cannot find attribute " + name);
            return loc;
        }

        function getUniformLocation(prog, name) {
            const loc = gl.getUniformLocation(prog, name);
            if (loc === -1) console.warn("Cannot find uniform " + name);
            return loc;
        }

        const vertexShader = compileShader(vertexSource, gl.VERTEX_SHADER);
        const fragmentShader = compileShader(fragmentSource, gl.FRAGMENT_SHADER);
        if (!vertexShader || !fragmentShader) return;

        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error("Program link failed: " + gl.getProgramInfoLog(program));
            return;
        }
        gl.useProgram(program);

        const vertexData = new Float32Array([
            -1.0, 1.0,
            -1.0, -1.0,
            1.0, 1.0,
            1.0, -1.0
        ]);

        const vertexDataBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexDataBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);

        const positionHandle = getAttribLocation(program, "position");
        gl.enableVertexAttribArray(positionHandle);
        gl.vertexAttribPointer(positionHandle, 2, gl.FLOAT, false, 2 * 4, 0);

        const timeHandle = getUniformLocation(program, "time");
        const widthHandle = getUniformLocation(program, "width");
        const heightHandle = getUniformLocation(program, "height");

        function resize() {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const w = window.innerWidth;
            const h = window.innerHeight;
            canvas.width = Math.floor(w * dpr);
            canvas.height = Math.floor(h * dpr);
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.uniform1f(widthHandle, canvas.width);
            gl.uniform1f(heightHandle, canvas.height);
        }

        window.addEventListener("resize", resize, { passive: true });
        resize();

        let time = 0.0;
        let lastFrame = performance.now();

        function draw(now) {
            if (document.hidden) {
                requestAnimationFrame(draw);
                return;
            }
            const dt = Math.min((now - lastFrame) / 1000, 0.05);
            lastFrame = now;
            time += dt;

            gl.uniform1f(timeHandle, time);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            requestAnimationFrame(draw);
        }

        requestAnimationFrame(draw);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initBackground);
    } else {
        initBackground();
    }
})();
