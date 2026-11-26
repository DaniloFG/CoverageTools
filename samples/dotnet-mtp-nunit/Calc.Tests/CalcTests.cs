using NUnit.Framework;

namespace Calc.Tests
{
    [TestFixture]
    public class CalcTests
    {
        [Test]
        public void AddsTwoNumbers()
        {
            Assert.That(Calculator.Add(2, 3), Is.EqualTo(5));
        }
    }
}
