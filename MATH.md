Yes. Once you have converted the crochet pattern into a graph, there are several mathematical models you can use. For **amigurumi-like, closed, stuffed, mostly convex objects**, I think the most useful formulation is:

> **Treat the crochet as a discrete elastic surface with prescribed intrinsic lengths, then inflate it with an internal pressure/volume constraint.**

This gives you both a physically meaningful model and a relatively straightforward numerical implementation.

### 1. Why the graph itself is insufficient

Suppose your crochet graph is

$$
G=(V,E)
$$

where each vertex is a stitch and each edge represents some yarn/stitch relationship.

You want coordinates

$$
x_i \in \mathbb R^3
$$

for every stitch.

But connectivity alone does **not** determine those coordinates. A chain or mesh can generally fold into infinitely many configurations without changing its graph.

At minimum, you want each relevant connection to have a target length

$$
L_{ij}.
$$

CrochetPARADE uses essentially this idea: nodes represent stitch points, edges have target lengths derived from stitch parameters, and the system searches for node positions that approximately satisfy those lengths. It also adds repulsion/inflation and relaxation mechanisms. ([GitHub][1])

For stuffed crochet, however, we can make the model considerably more physically meaningful.

---

# Model 1 — Spring graph

The simplest model is to make every crochet edge a spring.

For edge \(i,j\),

$$
E_{ij}
=
\frac12 k_{ij}
\left(
\|x_i-x_j\|-L_{ij}
\right)^2.
$$

Total stretching energy:

$$
E_{\text{stretch}}
=
\sum_{(i,j)\in E}
\frac12 k_{ij}
\left(
\|x_i-x_j\|-L_{ij}
\right)^2.
$$

Then solve

$$
\min_{x_1,\ldots,x_n}E_{\text{stretch}}.
$$

This is basically a **spring relaxation / force-directed embedding**.

### Problem

It doesn't know what "inside" and "outside" are.

For example, both of these can have almost identical edge lengths:

```text
       convex                   folded

        /\                      /\
      /    \                  /    \
     |      |                |  /\  |
      \    /                  \/  \/
        \/
```

So spring energy alone will frequently produce:

* collapsed structures,
* folding,
* self-intersection,
* weird concave regions,
* dependence on initialization.

That is why I would use this only as a first prototype.

---

# Model 2 — Elastic membrane + pressure

This is the model I recommend.

First turn your crochet graph into an **oriented surface mesh**.

For example, between crochet rounds \(r\) and \(r+1\):

```text
round r+1       o-----o-----o-----o
                |\    |\    |\    |
                | \   | \   | \   |
round r         o-----o-----o-----o
```

The regions between stitches become triangles.

Now your model contains

$$
M=(V,E,F)
$$

rather than only \(G=(V,E)\).

This change is extremely important because now you have:

* surface area,
* normals,
* enclosed volume,
* dihedral angles,
* curvature.

Then define several energy terms.

## Stretching

Same as before:

$$
E_s=
\sum_e
k_s
(l_e-L_e)^2.
$$

Crochet is relatively resistant to arbitrarily changing the distances between connected stitches, so this represents yarn tension/fabric stretch.

## Bending

For two triangles sharing an edge:

$$
E_b=
\sum_e
k_b(\theta_e-\theta_e^0)^2
$$

where \(\theta_e\) is the dihedral angle.

Discrete shell models use precisely this type of bending term to represent thin flexible surfaces. ([Doi.org][2])

For crochet you probably want

$$
k_b \ll k_s
$$

because crochet bends much more easily than it stretches.

## Internal pressure

Now comes the particularly useful part for amigurumi.

For a closed triangular mesh you can compute its volume:

$$
V(x)
=
\frac16
\sum_{(i,j,k)\in F}
x_i\cdot(x_j\times x_k).
$$

Stuffing can then be approximated by either **pressure** or a **target-volume constraint**.

For pressure:

$$
E_p=-pV.
$$

Minimize

$$
E =
E_s+E_b-pV.
$$

Increasing volume lowers the pressure energy, but stretching the crochet costs energy.

Eventually:

$$
\text{pressure force}
\approx
\text{fabric tension}.
$$

The surface reaches equilibrium.

Alternatively, use a volume penalty:

$$
E_V =
k_V(V-V_0)^2.
$$

PBD formulations explicitly support volume/pressure constraints for closed cloth meshes—the classic example is essentially an inflated cloth balloon. ([Google Patents][3])

This is very close conceptually to:

> **a crocheted balloon whose preferred surface metric comes from the pattern.**

For stuffed amigurumi, that is a surprisingly good first approximation.

---

# Model 3 — Intrinsic geometry / Gaussian curvature

There is an even more interesting mathematical way to think about the problem.

The crochet pattern may tell you the **intrinsic geometry** of the surface, while the simulator's job is to discover how that intrinsic geometry embeds into 3D.

Imagine that your triangulated crochet surface specifies all triangle edge lengths.

For one triangle:

$$
(a,b,c)
$$

you can calculate its internal angles entirely from those lengths using the cosine rule:

$$
\cos\alpha =
\frac{b^2+c^2-a^2}{2bc}.
$$

So you don't need a 3D embedding yet.

Now consider one vertex.

If its incident triangle angles are

$$
\theta_1,\theta_2,\ldots,\theta_n,
$$

its discrete Gaussian curvature is the **angle defect**

$$
\Omega_i
=
2\pi-\sum_j\theta_j.
$$

This is the standard discrete analogue of integrated Gaussian curvature. ([GitHub][4])

This immediately gives you something extremely useful for crochet.

If

$$
\sum_j\theta_j = 2\pi
$$

then

$$
\Omega_i=0
$$

and the surface wants to be locally flat.

If

$$
\sum_j\theta_j < 2\pi
$$

then

$$
\Omega_i>0
$$

and the surface wants **positive curvature**:

```text
        /\
      /    \
     /      \
```

If

$$
\sum_j\theta_j > 2\pi
$$

then

$$
\Omega_i<0
$$

and you tend toward saddle/ruffling behavior.

This connects directly to crochet increases/decreases.

An oversupply of circumference relative to radial distance tends toward negative curvature/ruffling; reducing circumference produces positive curvature.

So instead of thinking:

> increase → some arbitrary 3D deformation

you can think:

> stitch topology + stitch dimensions → intrinsic metric → Gaussian curvature → 3D shape.

That is a much more powerful abstraction.

---

# Convexity makes this especially interesting

There is a deep geometric result relevant to exactly your assumption.

Roughly speaking, **Alexandrov's theorem** says that under appropriate conditions, a positively curved metric on a sphere determines a **unique convex polyhedron**, up to rigid motion. There are constructive algorithms for recovering that polyhedron from its intrinsic metric. ([arXiv][5])

So conceptually:

$$
\boxed{\text{crochet pattern}}
$$

↓

$$
\boxed{\text{intrinsic edge lengths}}
$$

↓

$$
\boxed{\text{intrinsic metric}}
$$

↓

$$
\boxed{\text{positive Gaussian curvature}}
$$

↓

$$
\boxed{\text{convex 3D surface}}
$$

This is probably the most mathematically elegant formulation of your problem.

There is an important qualification, though: a real crochet pattern does not provide a perfectly rigid piecewise-Euclidean metric. Yarn stretches, stitches deform, holes change shape, and the material has thickness. So I would use Alexandrov/discrete differential geometry as the **geometric foundation**, but still solve an elastic optimization problem rather than demand exact edge lengths.

---

# Model 4 — XPBD/PBD as the numerical solver

PBD and XPBD aren't really alternative physical models; they are particularly convenient ways of **solving** the model above.

PBD directly corrects vertex positions to satisfy constraints rather than integrating large spring forces. It was developed partly for stable interactive cloth simulation. ([ScienceDirect][6])

XPBD extends this to make constraint stiffness less dependent on timestep and iteration count. ([Doi.org][7])

Your constraints could be:

$$
C_{\text{edge}}
=
\|x_i-x_j\|-L_{ij}=0
$$

$$
C_{\text{bend}}
=
\theta-\theta_0=0
$$

$$
C_{\text{volume}}
=
V(x)-V_0=0
$$

plus:

$$
C_{\text{collision}}\ge0.
$$

This is probably how I would eventually implement a real-time version.

---

# One energy function for your entire problem

A useful mathematical formulation is therefore:

$$
\boxed{
E(x)=
\lambda_sE_{\text{stretch}}
+
\lambda_bE_{\text{bend}}
+
\lambda_VE_{\text{volume}}
+
\lambda_cE_{\text{collision}}
}
$$

with

$$
E_{\text{stretch}}
=
\sum_{(i,j)}
\left(
\|x_i-x_j\|-L_{ij}
\right)^2
$$

$$
E_{\text{bend}}
=
\sum_h
(\theta_h-\theta_h^0)^2
$$

and

$$
E_{\text{volume}}
=
(V(x)-V_{\rm target})^2.
$$

Then simply compute

$$
x^*=\arg\min_x E(x).
$$

For pressure instead of fixed stuffing volume, replace the volume penalty with

$$
-pV(x).
$$

You don't actually need dynamics if all you want is the final crochet shape. You can solve this as a **static energy minimization problem**.

---

# Where the convex assumption enters

I would **not** initially impose a hard constraint saying "the mesh must be convex."

Instead, use convexity in three softer ways.

First, initialize the object as something convex—for example, project rounds onto nested circles/spheres.

Second, stuffing pressure naturally pushes the surface outward and tends to remove many concavities.

Third, check discrete curvature:

$$
\Omega_i
=
2\pi-\sum_f\theta_{if}.
$$

For an ideal convex polyhedron,

$$
\Omega_i\ge0.
$$

Therefore you can add a penalty such as

$$
E_{\text{nonconvex}}
=
\lambda_K
\sum_i
\max(0,-\Omega_i)^2.
$$

I would only add this if pressure + elasticity does not produce sufficiently convex shapes.

---

# An especially useful interpretation for crochet

Consider a standard amigurumi sphere:

```text
6 sc
inc around       -> 12
(sc, inc)        -> 18
(2sc, inc)       -> 24
...
straight rounds
...
decreases
...
6 sc
```

Rather than interpreting those counts as directly specifying radius, think of them as specifying the **preferred circumference of each latitude**.

If stitch width is \(w\),

$$
C_r \approx N_r w.
$$

So approximately,

$$
R_r\approx\frac{N_rw}{2\pi}.
$$

The vertical spacing between rounds is approximately stitch height \(h\).

This gives you an initial axisymmetric embedding:

$$
x_{r,i}
=
\begin{bmatrix}
R_r\cos(2\pi i/N_r)\\
R_r\sin(2\pi i/N_r)\\
z_r
\end{bmatrix},
\qquad
z_r\approx rh.
$$

But you should **not** regard this as the final geometry.

Use it as the initial state for:

$$
\text{elastic relaxation + stuffing pressure}.
$$

That should produce a much more realistic result.

---

## What I would build first

For your project, I'd use this sequence:

1. **Pattern → stitch graph**
2. Add different target lengths for stitch relationships.
3. **Convert graph → oriented triangular surface mesh.**
4. Calculate an approximate intrinsic metric from stitch dimensions.
5. Generate a rough convex initial embedding.
6. Minimize

$$
E_s + \alpha E_b + \beta(V-V_0)^2.
$$

7. Add self-collision.
8. Later replace the optimizer with XPBD if you need interactive speed.

The most important conceptual shift is therefore:

$$
\boxed{
\text{Don't solve graph} \rightarrow \text{3D coordinates directly.}
}
$$

Instead solve:

$$
\boxed{
\text{crochet graph}
\rightarrow
\text{intrinsic surface geometry}
\rightarrow
\text{elastic inflated surface}
\rightarrow
\text{3D shape}.
}
$$

CrochetPARADE's edge-length relaxation is a useful baseline, but the **intrinsic metric + discrete shell + volume/pressure** formulation should be significantly better suited to stuffed convex crochet. ([GitHub][8])

A particularly interesting next step is to work out **exactly how `sc`, `inc`, and `dec` should translate into triangles, rest edge lengths, and therefore discrete Gaussian curvature**. That would get us from a crochet pattern such as `6 sc → 12 sc → 18 sc` all the way to the mathematical inputs of the 3D solver.

[1]: https://github.com/stassev/CrochetPARADE?utm_source=chatgpt.com "GitHub - stassev/CrochetPARADE: CrochetPARADE (Crochet PAttern Renderer, Analyzer, and DEbugger) is a platform that allows users to create, visualize, and analyze both 2D and 3D crochet patterns. · GitHub"
[2]: https://doi.org/10.1145/1198555.1198663?utm_source=chatgpt.com "A discrete model of thin shells | ACM SIGGRAPH 2005 Courses"
[3]: https://patents.google.com/patent/US7616204B2/en?utm_source=chatgpt.com "US7616204B2 - Method of simulating dynamic objects using position based dynamics - Google Patents"
[4]: https://github.com/alecjacobson/geometry-processing-curvature?utm_source=chatgpt.com "GitHub - alecjacobson/geometry-processing-curvature: Curvature assignment for Geometry Processing course · GitHub"
[5]: https://arxiv.org/abs/math/0609447?utm_source=chatgpt.com "Alexandrov's theorem, weighted Delaunay triangulations, and mixed volumes"
[6]: https://www.sciencedirect.com/science/article/abs/pii/S1047320307000065?utm_source=chatgpt.com "Position based dynamics - ScienceDirect"
[7]: https://doi.org/10.1145/2994258.2994272?utm_source=chatgpt.com "XPBD | Proceedings of the 9th International Conference on Motion in Games"
[8]: https://github.com/stassev/CrochetPARADE/blob/main/capabilities.md?utm_source=chatgpt.com "CrochetPARADE/capabilities.md at main · stassev/CrochetPARADE · GitHub"
